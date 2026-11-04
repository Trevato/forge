/**
 * The release keeper (#7557): plain code, no model, on the forge's own
 * timer, so releases keep going out when no one is at the keyboard. It is
 * the steward's `release.sh`, `verify-after.sh` and `verify-release.sh`
 * moved inside:
 *
 * 1. **Cut** on cadence (`cadence.ts`): the known-good version and image
 *    are recorded, then the annotated tag `v<version>` is made on main's
 *    head — a tag, never a commit, so no gate in flight is voided (#6640).
 * 2. **Promote**: the Deployment is set to the new version's image (or,
 *    with `swapper.ts` as the deployer, #8042, main's tree is swapped in beside
 *    this process on the same port: no image, no registry, no roll); it
 *    rolls with surge (`maxSurge 1, maxUnavailable 0`). The old forge
 *    probes `/healthz` each second while it still serves (`rollProbe`),
 *    so a roll that went dark says how long.
 * 3. **Verify**: the new forge, finding itself the version in flight,
 *    spends ten minutes under page load (`verify.ts`).
 * 4. **Verified live**, or **roll back** to the named known-good image
 *    (`rollback.ts`; there is no undo) and **hold** with the numbers
 *    (`hold.ts`). A release with seconds dark files one issue.
 *
 * Each step is an event on the outbox: `release.cut`, `release.released`,
 * `release.verified_live`, `release.rolled_back`, `release.held`.
 *
 * Guardrail: the keeper's only writes are a tag, the Deployment's image,
 * its own rows, and issues. It holds no account that may land a pull or
 * push main, and it has no code path to either.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import { createIssue } from "../core/issues.ts";
import { decideCut } from "./cadence.ts";
import { imageAt, type Deployer } from "./deploy.ts";
import { blocking, liftFixed, names, setCause, setHold, standingHolds, type Hold } from "./hold.ts";
import { stallReason, STALL_HOLD_MS } from "../perf/boot_stall.ts";
import { countRollProbe, dropCut, finish, getKeeperRelease, inFlight, keepStall, keepTally, listKeeperReleases, markLive, releaseBefore, recordCut, type KeeperRelease } from "./record.ts";
import { rollBackToNamed } from "./rollback.ts";
import type { Probe, Tally, Verdict } from "./verify.ts";

/** A release not live this long after its cut never rolled: 3 h (the tag's check may take 2 h, the build some more). */
export const ROLL_DEADLINE_MS = 3 * 3_600_000;

export interface KeeperPorts {
  readonly db: Database;
  readonly bus: EventBus;
  /** The forge's own repository, for events and the issues the keeper files. */
  readonly repo: { readonly id: string; readonly ownerId: string };
  readonly now: () => number;
  /** The version this process runs. */
  readonly live: () => string;
  readonly main: () => Promise<string | undefined>;
  readonly newest: () => Promise<{ version: string; sha: string } | undefined>;
  /** Merge-queue gates running now. */
  readonly gating: () => number;
  readonly deployer: Deployer;
  /** Make the annotated tag `v<version>` on `sha` and send it where the release workflow starts; why not. */
  readonly tag: (version: string, sha: string) => Promise<string | undefined>;
  /** One `/healthz` probe through the public URL. */
  readonly probe: () => Promise<Probe>;
  /** Ten minutes under page load. */
  readonly verify: (onProbe: (t: Tally) => void) => Promise<Verdict>;
  readonly minIntervalMs?: number;
  /** The worst event-loop stall in this process's first five minutes, ms; none when unset (#8848). */
  readonly bootStallMs?: () => number;
}

/** Pulls of the forge's repository merged since `since`: number, title and body. */
function landedSince(db: Database, repoId: string, since: string): { number: number; text: string }[] {
  return db
    .query<{ number: number; title: string; body: string | null }, [string, string]>(
      `SELECT issue.number, issue.title, issue.body FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE issue.repo_id = ?1 AND pull.merged_at IS NOT NULL AND pull.merged_at > ?2 ORDER BY pull.merged_at LIMIT 500`,
    )
    .all(repoId, since)
    .map((r) => ({ number: r.number, text: `${r.title}\n${r.body ?? ""}` }));
}

/** Name the landed pull that fixes each failed hold. */
function findCauses(p: KeeperPorts, holds: readonly Hold[]): void {
  for (const h of holds) {
    if (h.kind !== "failed" || h.causePull !== null) continue;
    const fix = landedSince(p.db, p.repo.id, h.createdAt).find((x) => names(h, x.text));
    if (fix !== undefined) setCause(p.db, h.id, fix.number);
  }
}

/** One issue for a release that went dark, unless one by its title is open. */
function fileDark(p: KeeperPorts, r: KeeperRelease): number | undefined {
  if (r.secondsDark <= 0) return undefined;
  const title = `Release ${r.version} was dark for ${r.secondsDark} s`;
  const open = p.db
    .query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND title = ?2 AND state = 'open'`)
    .get(p.repo.id, title)!.n;
  if (open > 0) return undefined;
  const made = createIssue(p.db, {
    repoId: p.repo.id,
    authorId: p.repo.ownerId,
    title,
    body:
      `_Filed by the release keeper, not written by a person._\n\n` +
      `${r.version} (${r.sha.slice(0, 12)}) did not answer \`/healthz\` with a 200 for ${r.secondsDark} probe-seconds: ` +
      `${r.rollNon200} of ${r.rollProbes} during the roll, the rest of ${r.probes} under page load; worst ${r.worstMs} ms. ` +
      `The target is 0 s: the forge rolls with \`maxSurge 1, maxUnavailable 0\`. ` +
      `${r.stage === "rolled_back" ? `It was rolled back to ${r.knownGood.version}.` : "It stayed live."}\n\n` +
      `Files: src/keeper/keeper.ts, charts/app/templates/deployment.yaml`,
  });
  if (!made.ok) return undefined;
  p.bus.append({ kind: "issue.opened", repoId: p.repo.id, actorId: p.repo.ownerId, payload: { number: made.value.number } });
  return made.value.number;
}

/** The release each keeper is verifying; keyed by its ports, so one keeper (or one test) never sees another's. */
const verifying = new WeakMap<KeeperPorts, number>();

/** The verify of an in-flight release this process is the new version of, to its end. */
async function verifyAndDecide(p: KeeperPorts, r: KeeperRelease): Promise<string> {
  if (verifying.has(p)) return `verifying ${r.version}`;
  verifying.set(p, r.id);
  try {
    const verdict = await p.verify((t) => keepTally(p.db, r.id, t, r.rollNon200));
    keepTally(p.db, r.id, verdict.tally, r.rollNon200);
    const kept = getKeeperRelease(p.db, r.id)!;
    const numbers = { version: r.version, probes: kept.probes, pages: kept.pages, worstMs: kept.worstMs, secondsDark: kept.secondsDark, rollNon200: kept.rollNon200 };
    if (verdict.ok) {
      const stalled = holdStall(p, r);
      finish(p.db, r.id, "verified", stalled ?? "", p.now());
      p.deployer.verified?.(r.version);
      const lifted = liftFixed(p.db, r.version, p.now());
      p.bus.append({ kind: "release.verified_live", repoId: p.repo.id, payload: { ...numbers, holdsLifted: lifted } });
      fileDark(p, getKeeperRelease(p.db, r.id)!);
      return `${r.version} verified live: ${kept.probes} probes, worst ${kept.worstMs} ms, ${kept.secondsDark} s dark${stalled === undefined ? "" : `; ${stalled}`}`;
    }
    return await rollBack(p, kept, verdict.reason);
  } finally {
    verifying.delete(p);
  }
}

/**
 * A release's worst stall in its first five minutes is kept, shown beside the last
 * release's, and over {@link STALL_HOLD_MS} holds the next cut with the reason
 * (#8848). The release itself stays live: it answers, only slowly for a while, so
 * a rollback would trade a known stall for a restart. The hold lifts as any failed
 * one does, when a pull naming it lands and a release verifies.
 */
function holdStall(p: KeeperPorts, r: KeeperRelease): string | undefined {
  const ms = p.bootStallMs?.();
  if (ms === undefined) return undefined;
  keepStall(p.db, r.id, ms);
  if (ms <= STALL_HOLD_MS) return undefined;
  const reason = stallReason(r.version, ms, releaseBefore(p.db, r.id)?.worstStallMs);
  const hold = setHold(p.db, { kind: "failed", version: r.version, reason, worstMs: ms, at: p.now() });
  p.bus.append({ kind: "release.held", repoId: p.repo.id, payload: { version: r.version, hold: hold.id, reason, worstStallMs: ms } });
  return `${reason}; hold ${hold.id} set`;
}

/** Hold with the numbers, then set the named known-good image. The hold first: this process may be the one replaced. */
async function rollBack(p: KeeperPorts, r: KeeperRelease, reason: string): Promise<string> {
  const hold = setHold(p.db, { kind: "failed", version: r.version, reason, probes: r.probes, badInRow: r.badInRow, worstMs: r.worstMs, at: p.now() });
  p.bus.append({ kind: "release.held", repoId: p.repo.id, payload: { version: r.version, hold: hold.id, reason, probes: r.probes, badInRow: r.badInRow, worstMs: r.worstMs } });
  const back = await rollBackToNamed(p.deployer, r.knownGood);
  const line = back.ok ? `rolled back to ${r.knownGood.version} (${back.image})` : `rollback failed: ${back.line}`;
  finish(p.db, r.id, "rolled_back", `${reason}; ${line}`, p.now());
  p.bus.append({ kind: "release.rolled_back", repoId: p.repo.id, payload: { version: r.version, to: r.knownGood.version, image: r.knownGood.image, ok: back.ok } });
  fileDark(p, getKeeperRelease(p.db, r.id)!);
  return `${r.version} failed its verify: ${reason}; ${line}; hold ${hold.id} set`;
}

/** One step of the keeper; the line says what it did or why it did nothing. */
export async function tick(p: KeeperPorts): Promise<string> {
  const holds = standingHolds(p.db);
  findCauses(p, holds);
  const flying = inFlight(p.db);
  if (flying !== undefined) {
    if (p.live() === flying.version) {
      markLive(p.db, flying.id, p.now());
      return verifyAndDecide(p, getKeeperRelease(p.db, flying.id)!);
    }
    // A cut recorded but never tagged (the process died between the two): tag it now, or drop it.
    if (flying.stage === "rolling" && (await p.newest())?.version !== flying.version) {
      const refused = await tagged(p, flying);
      if (refused !== undefined) return refused;
    }
    if (flying.stage === "rolling" && p.now() - Date.parse(flying.cutAt) > ROLL_DEADLINE_MS)
      return rollBack(p, flying, `${flying.version} was not live ${ROLL_DEADLINE_MS / 3_600_000} h after its cut`);
    // A promote that did not take (the API refused, or something set the image back) is sent again.
    const want = refFor(p, flying.knownGood.image, flying.version, flying.sha);
    if (flying.stage === "rolling" && (await p.deployer.image()) !== want) await promote(p, flying.version, want);
    return `${flying.version} is ${flying.stage}`;
  }
  const main = await p.main();
  const newest = await p.newest();
  const last = listKeeperReleases(p.db, 1)[0];
  const decision = decideCut({
    main: main ?? "",
    newest,
    live: p.live(),
    settled: newest !== undefined && rolledBack(p.db, newest.version),
    inFlight: false,
    gating: p.gating(),
    lastCutAt: last === undefined ? undefined : Date.parse(last.cutAt),
    hold: blocking(standingHolds(p.db)),
    now: p.now(),
    ...(p.minIntervalMs === undefined ? {} : { minIntervalMs: p.minIntervalMs }),
  });
  if (!decision.cut || main === undefined) return decision.cut ? "main is unreadable" : decision.why;
  // A tree the deployer cannot release (dependencies changed, preflight red) is not cut: no tag, no row.
  const refused = await p.deployer.admits?.(main);
  if (refused !== undefined) return `not cut: ${refused}`;
  const image = await p.deployer.image();
  const knownGood = { version: p.live(), image };
  // The row first, the tag second: a crash between them leaves a `rolling` row
  // whose tag the next tick sends (`tagged`), never a tag the keeper has no row for.
  const r = recordCut(p.db, { version: decision.version, sha: main, knownGood, at: p.now() });
  const tagRefused = await tagged(p, r);
  if (tagRefused !== undefined) return tagRefused;
  const sent = await promote(p, r.version, refFor(p, image, r.version, main));
  return `cut ${r.version} at ${main.slice(0, 12)}; ${sent}; known good: ${knownGood.version}`;
}

const refFor = (p: KeeperPorts, image: string, version: string, sha: string): string =>
  p.deployer.refFor?.(version, sha) ?? imageAt(image, version);

/** Make the release's tag; when it is refused the cut is dropped and the line says why. */
async function tagged(p: KeeperPorts, r: KeeperRelease): Promise<string | undefined> {
  const refused = await p.tag(r.version, r.sha);
  if (refused !== undefined) {
    dropCut(p.db, r.id);
    return `not cut: ${refused}`;
  }
  p.bus.append({ kind: "release.cut", repoId: p.repo.id, payload: { version: r.version, sha: r.sha, knownGood: r.knownGood.version, image: r.knownGood.image } });
  return undefined;
}

/** Set the Deployment to the new version's image; it rolls with surge. */
async function promote(p: KeeperPorts, version: string, image: string): Promise<string> {
  try {
    await p.deployer.setImage(image);
  } catch (error) {
    return `promote to ${image} refused (${error instanceof Error ? error.message : String(error)}); sent again next tick`;
  }
  p.bus.append({ kind: "release.released", repoId: p.repo.id, payload: { version, image } });
  return `promoted to ${image}`;
}

/** The keeper rolled this version back: its tag is settled, not still promoting. */
function rolledBack(db: Database, version: string): boolean {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM keeper_release WHERE version = ?1 AND stage = 'rolled_back'`).get(version)!.n > 0;
}

/** The old forge's probe while a release rolls: one `/healthz`, counted toward the roll. */
export async function rollProbe(p: Pick<KeeperPorts, "db" | "live" | "probe">): Promise<void> {
  const r = inFlight(p.db);
  if (r === undefined || r.stage !== "rolling" || p.live() === r.version) return;
  const got = await p.probe();
  countRollProbe(p.db, r.id, got.status === 200);
}
