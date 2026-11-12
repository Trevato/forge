/**
 * The probe as a service: after every production deploy of an app with a
 * contract, once a night for all of them, and on demand. Each result is a
 * row, so the audit can show what the app said last and what changed.
 *
 * A mismatch is one issue on the app — never one per cell — titled the same
 * every time so it is found, not doubled, and closed by the next probe that
 * comes back clean. The forge never edits a contract to match an app: the
 * table is the policy, and the issue is the work.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { AppsRuntime } from "../apps/runtime.ts";
import { listIssues } from "../core/issues.ts";
import { getAppByRepo, listApps, type AppRecord } from "../core/apps.ts";
import type { ForgeEvent } from "../core/events.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { openIssue, setIssueState } from "../actions/issues.ts";
import { id as newId } from "../kernel/id.ts";
import { createLog } from "../kernel/log.ts";
import { audit } from "./audit.ts";
import { probe, type Knock, type ProbeInput, type Probed } from "./probe.ts";
import { during } from "../perf/jobs.ts";

const log = createLog("probes");

export const PROBE_ISSUE_TITLE = "The app does not obey its contract";
/** When the nightly round runs, in UTC. */
const NIGHTLY_HOUR_UTC = 9;
/** A deploy has come up when its run finished; the doors are asked shortly after. */
const AFTER_DEPLOY_MS = 1_500;

export interface ProbeRow {
  readonly id: string;
  readonly appId: string;
  readonly commitOid: string;
  readonly verdict: Probed["verdict"];
  readonly said: readonly string[];
  readonly knocks: readonly Knock[];
  readonly createdAt: string;
}

interface Row {
  id: string;
  app_id: string;
  commit_oid: string;
  verdict: string;
  said: string;
  knocks: string;
  created_at: string;
}

const toRow = (r: Row): ProbeRow => ({
  id: r.id,
  appId: r.app_id,
  commitOid: r.commit_oid,
  verdict: r.verdict as Probed["verdict"],
  said: JSON.parse(r.said) as string[],
  knocks: JSON.parse(r.knocks) as Knock[],
  createdAt: r.created_at,
});

export function recordProbe(db: Database, appId: string, probed: Probed): ProbeRow {
  const row = db
    .query<Row, [string, string, string, string, string, string]>(
      `INSERT INTO probe (id, app_id, commit_oid, verdict, said, knocks)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *`,
    )
    .get(
      newId(),
      appId,
      probed.commitOid,
      probed.verdict,
      JSON.stringify(probed.said),
      JSON.stringify(probed.knocks),
    )!;
  return toRow(row);
}

/** The newest probe of each app, for the apps given. */
export function latestProbes(
  db: Database,
  appIds: readonly string[],
): Map<string, ProbeRow> {
  const out = new Map<string, ProbeRow>();
  for (const appId of new Set(appIds)) {
    const row = db
      .query<Row, [string]>(
        "SELECT * FROM probe WHERE app_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(appId);
    if (row) out.set(appId, toRow(row));
  }
  return out;
}

/** The probes of one app, newest first. */
export function listProbes(db: Database, appId: string, limit = 30): ProbeRow[] {
  return db
    .query<Row, [string, number]>(
      "SELECT * FROM probe WHERE app_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    )
    .all(appId, limit)
    .map(toRow);
}

/** The open issue a mismatch keeps, if there is one. */
export function probeIssue(app: App, repo: Repo) {
  return listIssues(app.db, repo.id, { sealed: true, state: "open", limit: 200 }).find(
    (i) => i.title === PROBE_ISSUE_TITLE,
  );
}

/** What asks the doors: the real probe, unless a test hands in its own verdicts. */
export type Prober = (input: ProbeInput) => Promise<Probed | undefined>;

/**
 * Knock on one app now, keep the row, and open or close its issue. Returns
 * undefined for an app with no sound contract: there is nothing to compare
 * the doors with.
 */
export async function probeApp(
  app: App,
  runtime: AppsRuntime,
  record: AppRecord,
  knock: Prober = probe,
): Promise<ProbeRow | undefined> {
  const repo = getRepoById(app.db, record.repoId);
  if (repo === undefined) return undefined;
  const audited = await audit(app.reposRoot, repo);
  const probed = await knock({
    runtime,
    dataDir: app.config.dataDir,
    record,
    repo,
    standing: audited.standing,
    // An identity that names no row anywhere: the app sees a signed user
    // it has never stored, which is exactly a stranger with an account.
    who: { id: `probe:${record.id}`, name: "probe" },
  });
  if (probed === undefined) return undefined;
  const row = recordProbe(app.db, record.id, probed);
  reconcileIssue(app, repo, probed);
  return row;
}

/** One issue while the app disobeys; closed by the first clean probe after. */
function reconcileIssue(app: App, repo: Repo, probed: Probed): void {
  const open = probeIssue(app, repo);
  // The issue is opened as the repository's owner — the person whose policy
  // it is — like the crew's own proposals.
  const owner = getUserById(app.db, repo.ownerId);
  const as = owner?.kind === "user" ? owner : undefined;
  if (probed.verdict === "mismatch") {
    if (open !== undefined || as === undefined) return;
    const body = [
      `The forge knocked on every door of \`${repo.ownerName}/${repo.name}\` at \`${probed.commitOid.slice(0, 7)}\` as nobody, a user and an admin, and compared each answer with \`contract.json\`. These disagree:`,
      "",
      ...probed.said.map((s) => `- ${s}`),
      "",
      "The table is the policy. Fix the door, not the table; the app's own `src/contract.test.ts` acts as every identity at every door and should have caught this. This issue closes itself when the next probe comes back clean.",
    ].join("\n");
    const opened = openIssue(app, as, repo, { title: PROBE_ISSUE_TITLE, body });
    if (!opened.ok)
      log.warn("could not open the audit issue", {
        repo: `${repo.ownerName}/${repo.name}`,
        error: String(opened.error),
      });
    return;
  }
  if (probed.verdict === "ok" && open !== undefined && as !== undefined) {
    const closed = setIssueState(app, as, repo, open, "closed");
    if (!closed.ok)
      log.warn("could not close the audit issue", {
        repo: `${repo.ownerName}/${repo.name}`,
        error: String(closed.error),
      });
  }
}

export interface ProbesHandle {
  /** Knock on every app with a contract, now. */
  readonly round: () => Promise<ProbeRow[]>;
  readonly stop: () => Promise<void>;
}

/** Milliseconds until the next nightly round. */
export function untilNightly(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(NIGHTLY_HOUR_UTC, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

export function startProbes(
  app: App,
  runtime: AppsRuntime,
  options: {
    readonly nightly?: boolean;
    /** The seam: a test's prober answers in place of the running app's doors. */
    readonly knock?: Prober;
  } = {},
): ProbesHandle {
  let stopped = false;
  const inFlight = new Set<Promise<unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    return p.finally(() => inFlight.delete(p));
  };
  const one = (record: AppRecord): Promise<ProbeRow | undefined> =>
    track(
      probeApp(app, runtime, record, options.knock).catch((error) => {
        log.error("probe failed", { app: record.slug, error: String(error) });
        return undefined;
      }),
    );

  const round = async (): Promise<ProbeRow[]> => {
    const out: ProbeRow[] = [];
    for (const record of listApps(app.db)) {
      if (stopped) break;
      const row = await one(record);
      if (row !== undefined) out.push(row);
    }
    return out;
  };

  const unsubscribe = app.bus.subscribe((event: ForgeEvent) => {
    if (stopped || event.repoId === null || event.kind !== "run.finished") return;
    const payload = event.payload;
    if (payload["kind"] !== "deploy" || payload["state"] !== "ok") return;
    if (payload["env"] !== "production") return;
    const record = getAppByRepo(app.db, event.repoId);
    if (!record) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) void during("probes", () => one(record));
    }, AFTER_DEPLOY_MS);
    timers.add(timer);
  });

  let nightly: ReturnType<typeof setTimeout> | undefined;
  const scheduleNightly = (): void => {
    if (options.nightly === false) return;
    nightly = setTimeout(() => {
      void track(during("probes", round)).finally(scheduleNightly);
    }, untilNightly());
  };
  scheduleNightly();

  return {
    round: () => track(round()),
    stop: async () => {
      stopped = true;
      unsubscribe();
      for (const t of timers) clearTimeout(t);
      if (nightly !== undefined) clearTimeout(nightly);
      await Promise.allSettled([...inFlight]);
    },
  };
}
