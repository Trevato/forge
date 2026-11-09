/**
 * An adapter pulled on its schedule (#10043, docs/ADAPTERS.md): on a tick the
 * forge POSTs `/pull` to each app whose production is running, whose
 * `forge.json` on the default branch has an `adapter` block
 * (`apps/adapter.ts`), and whose last pull is at least `schedule.every`
 * seconds old. The answer is judged by `parsePullAnswer` and kept by
 * `recordPull` (`apps/pull.ts`). The request goes over the same loopback reach
 * the scheduled tools use (`feature_tools.ts`): 64 KB, 10 s. An app that is
 * not running is skipped, never woken; two pulls of one app never overlap.
 * The call is signed as an `admin` the way the proxy signs a person
 * (`identityHeaders`, `apps/proxy.ts`), under the app's identity key, so an
 * adapter that admits only admins to `/pull` (examples/adapter-template)
 * admits the forge. Only the signature travels; the key never does.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { listApps, type AppRecord } from "../core/apps.ts";
import { getRepoById } from "../core/repos.ts";
import { lastPullAt } from "../core/runs.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { parseAdapter, type AdapterSpec } from "./adapter.ts";
import { readFileAt } from "./checkout.ts";
import { identityHeaders, type GrantWho } from "./proxy.ts";
import { parsePullAnswer, PULL_BODY_MAX, recordPull, type PullAnswer } from "./pull.ts";
import { appsRuntime } from "./runtime.ts";

/** How long the forge waits for one `/pull` answer, as for a scheduled tool. */
export const PULL_WAIT_MS = 10_000;

/** Whether a pull is due: never pulled, or at least `everySeconds` since the last one (ms clock). */
export function isPullDue(lastAt: number | undefined, everySeconds: number, now: number): boolean {
  return lastAt === undefined || now - lastAt >= everySeconds * 1000;
}

/** What the forge heard from `POST /pull`: a status and the body as text, or why there was none. */
export type PullReply = { readonly status: number; readonly body: string } | { readonly error: string };

/** What `pullApp` needs from the running forge for one app; the seam a test replaces. */
export interface PullReach {
  /** The production port when it is running; undefined otherwise (asleep, stopped, never deployed). */
  port(): number | undefined;
  /** The `adapter` block the default branch declares now; undefined when it is not an adapter. */
  adapter(): Promise<AdapterSpec | undefined>;
  /** Send `POST /pull` to the app on `port`. */
  post(port: number): Promise<PullReply>;
}

const inFlight = new Set<string>();

/** The answer a reply is worth: a reply with no status is a failed pull naming why. */
export function answerOf(reply: PullReply): PullAnswer {
  if ("error" in reply) return { ok: false, reason: reply.error };
  return parsePullAnswer(reply.status, reply.body);
}

/**
 * Pull one app if it is a running adapter and due: whether a pull was made.
 * The checks run cheapest first — running, then in flight, then declared,
 * then due — so a sleeping app costs no git read and is never reached.
 */
export async function pullApp(db: Database, appId: string, reach: PullReach, now: () => number = Date.now): Promise<boolean> {
  const port = reach.port();
  if (port === undefined) return false;
  if (inFlight.has(appId)) return false;
  inFlight.add(appId);
  try {
    const adapter = await reach.adapter();
    if (adapter === undefined) return false;
    if (!isPullDue(lastPullAt(db, appId), adapter.schedule.every, now())) return false;
    const started = now();
    const answer = answerOf(await reach.post(port));
    recordPull(db, appId, { ...answer, durationMs: Math.max(0, now() - started) });
    return true;
  } finally {
    inFlight.delete(appId);
  }
}

/** Who the forge says it is when it pulls: an admin of the app, named for itself. */
export const PULL_CALLER: GrantWho = { id: "forge", name: "forge", role: "admin" };

/**
 * The signed identity one scheduled pull carries: `PULL_CALLER`, good only
 * for as long as the forge waits for the answer.
 */
export function pullIdentity(dataDir: string, appId: string, now: number = Date.now()): Record<string, string> {
  return identityHeaders(dataDir, appId, { who: PULL_CALLER, expiresMs: now + PULL_WAIT_MS });
}

/**
 * POST `/pull` on loopback with `identity` (the signed headers, never a key):
 * at most 64 KB read (one byte over, so the judge says so), 10 s.
 */
export async function postPull(
  port: number,
  identity: Record<string, string> = {},
  waitMs: number = PULL_WAIT_MS,
): Promise<PullReply> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pull`, {
      method: "POST",
      headers: { ...identity, "content-type": "application/json", accept: "application/json" },
      body: "{}",
      redirect: "manual",
      signal: AbortSignal.timeout(waitMs),
    });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader !== undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > PULL_BODY_MAX) {
        await reader.cancel();
        return { error: `body is over ${PULL_BODY_MAX} bytes` };
      }
      chunks.push(value);
    }
    return { status: res.status, body: Buffer.concat(chunks).toString("utf8") };
  } catch {
    return { error: "the app did not answer" };
  }
}

/** The adapter block by default-branch tip: a tick costs a git read only when a tip is new. */
const declaredByTip = new Map<string, AdapterSpec | undefined>();
const DECLARED_MAX = 256;

async function declaredAdapter(app: App, record: AppRecord): Promise<AdapterSpec | undefined> {
  const repo = getRepoById(app.db, record.repoId);
  if (repo === undefined) return undefined;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return undefined;
  if (declaredByTip.has(tip)) return declaredByTip.get(tip);
  const text = await readFileAt(dir, tip, "forge.json");
  let spec: AdapterSpec | undefined;
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const read = parseAdapter((parsed as Record<string, unknown>)["adapter"]);
        spec = read.ok ? read.value : undefined; // a bad block is the deploy's to report
      }
    } catch {
      spec = undefined;
    }
  }
  if (declaredByTip.size >= DECLARED_MAX) declaredByTip.clear();
  declaredByTip.set(tip, spec);
  return spec;
}

/** What `pullApp` reaches for one app in the real runtime: only a production that is running, never woken. */
export function runtimePullReach(app: App, record: AppRecord): PullReach {
  return {
    port: () => {
      const status = appsRuntime(app)?.envStatus(record, "production");
      return status?.state === "running" ? status.port : undefined;
    },
    adapter: () => declaredAdapter(app, record),
    post: (port) => postPull(port, pullIdentity(app.config.dataDir, record.id)),
  };
}

/** Every app, one after another; the apps pulled. `reachOf` is the seam a test replaces. */
export async function pullDue(
  app: App,
  now: () => number = Date.now,
  reachOf: (record: AppRecord) => PullReach = (record) => runtimePullReach(app, record),
): Promise<string[]> {
  const pulled: string[] = [];
  for (const record of listApps(app.db)) {
    try {
      if (await pullApp(app.db, record.id, reachOf(record), now)) pulled.push(record.slug);
    } catch (error) {
      app.log.warn("could not pull an adapter", { app: record.slug, error: String(error) });
    }
  }
  return pulled;
}

const TICK_MS = 60_000;

/** The timer. Off under `bun test` (NODE_ENV=test) so no sweep outlives a test; a test calls `pullDue`. */
export function startPullSchedule(app: App, tickMs: number = TICK_MS): { stop(): void } | undefined {
  if (process.env["NODE_ENV"] === "test") return undefined;
  let running = false;
  const tick = setInterval(() => {
    if (running) return;
    running = true;
    void pullDue(app).finally(() => (running = false));
  }, tickMs);
  tick.unref();
  return { stop: () => clearInterval(tick) };
}
