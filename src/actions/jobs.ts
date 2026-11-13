/**
 * An app's durable job runs, seen and steered (#11596). The runs live in the
 * app's own data (`src/jobs.ts` of the app template), so the forge asks the app, waking it if
 * it sleeps: a signed `GET /jobs/runs`, and a signed `POST /jobs/runs/:id/cancel`
 * or `…/retry`, signed as a timer's delivery is (`controlHeaders`). The page,
 * `GET …/jobs`, the MCP tool and the terminal read these functions, so they
 * say the same words. Writers only: a run's error and result are the app's
 * own text. Production's runs; a preview keeps its own in its own data.
 */

import type { App } from "../app.ts";
import { runtimeReach } from "../apps/timer_service.ts";
import { controlHeaders, type Reach } from "../apps/timer_fire.ts";
import { getAppByRepo } from "../core/apps.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter } from "./access.ts";

/** How the forge reaches the app: the real runtime, unless a test hands in its own. */
export const jobReach: { override: Reach | undefined } = { override: undefined };
const reachOf = (app: App): Reach => jobReach.override ?? runtimeReach(app);

export const JOB_STATUSES = ["running", "sleeping", "waiting", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRunRow {
  readonly id: string;
  readonly job: string;
  readonly key: string;
  readonly status: JobStatus;
  /** ms epoch: when a sleeping run wakes, or a waiting run's timeout. */
  readonly until: number | null;
  readonly event: string | null;
  readonly error: string | null;
  readonly failedStep: string | null;
  readonly started: number;
  readonly updated: number;
  /** A finished run's result, as text, cut at 500 characters. */
  readonly result: string | null;
  /** Where it is now, in words. */
  readonly now: string;
}

export type JobError = "not_found" | "unauthorized" | "forbidden" | "unreachable" | "not_now" | "invalid";

export const JOB_WORDS: Record<"unreachable" | "not_now" | "invalid", string> = {
  unreachable: "The app did not answer, so its job runs cannot be read or changed now. It may be asleep and failing to start; look at its deploy.",
  not_now: "That run is not in a state that allows it: only an unfinished run can be cancelled and only a failed one retried.",
  invalid: "The action is cancel or retry, on a run id.",
};

const iso = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "?") : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Where a run is now: the words the page, the tool and the terminal share. */
export function nowWords(r: Pick<JobRunRow, "status" | "until" | "event" | "error" | "failedStep">): string {
  switch (r.status) {
    case "sleeping":
      return r.until === null ? "sleeping" : `sleeping until ${iso(r.until)}${r.error === null ? "" : " (retrying a step)"}`;
    case "waiting":
      return `waiting for ${r.event ?? "an event"}${r.until === null ? "" : `, until ${iso(r.until)} at the latest`}`;
    case "failed":
      return `failed${r.failedStep === null ? "" : ` at ${r.failedStep}`}`;
    default:
      return r.status;
  }
}

/** One row of the app's answer, or null when it is not one: the app's text is never trusted for its shape. */
function rowOf(v: unknown): JobRunRow | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const status = JOB_STATUSES.find((s) => s === o["status"]);
  const id = str(o["id"], 40);
  if (status === undefined || id === null || !/^[A-Za-z0-9-]{1,40}$/.test(id)) return null;
  const base = {
    id, job: str(o["job"], 60) ?? "", key: str(o["key"], 100) ?? "", status, until: num(o["until"]), event: str(o["event"], 200),
    error: str(o["error"], 500), failedStep: str(o["failedStep"], 100), started: num(o["started"]) ?? 0, updated: num(o["updated"]) ?? 0,
  };
  const result = o["result"] === null || o["result"] === undefined ? null : (str(typeof o["result"] === "string" ? o["result"] : JSON.stringify(o["result"]), 500));
  return { ...base, result, now: nowWords(base) };
}

/** What the app may answer with: a hundred rows of capped text fit well inside it. */
export const BODY_MAX = 1_000_000;

/** The body read as a stream with a byte cap; undefined (and the stream cancelled) once it passes the cap, so a large answer is never held in memory. */
export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    n += value.length;
    if (n > max) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function ask(app: App, repo: Repo, method: "GET" | "POST", path: string, reach: Reach): Promise<Result<unknown, "not_found" | "unreachable" | "not_now">> {
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return err("not_found");
  const port = await reach.ensure(record, "production").catch(() => undefined);
  if (port === undefined) return err("unreachable");
  try {
    const res = await reach.fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: controlHeaders(reach.identityKey(record.id), Date.now()), redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 409) return err("not_now");
    if (!res.ok) return err("unreachable");
    const body = await readCapped(res, BODY_MAX);
    return body === undefined ? err("unreachable") : ok(JSON.parse(body) as unknown);
  } catch {
    return err("unreachable");
  }
}

/** The runs, newest first. */
export async function jobRows(app: App, actor: User | undefined, repo: Repo, reach: Reach = reachOf(app)): Promise<Result<JobRunRow[], JobError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return err(writer.error);
  const got = await ask(app, repo, "GET", "/jobs/runs?limit=100", reach);
  if (!got.ok) return err(got.error);
  const runs = (got.value as { runs?: unknown } | null)?.runs;
  return ok(Array.isArray(runs) ? runs.slice(0, 100).map(rowOf).filter((r): r is JobRunRow => r !== null) : []);
}

export type JobAction = "cancel" | "retry";

export async function steerJob(app: App, actor: User | undefined, repo: Repo, id: string, action: string, reach: Reach = reachOf(app)): Promise<Result<true, JobError>> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return err(writer.error);
  if ((action !== "cancel" && action !== "retry") || !/^[A-Za-z0-9-]{1,40}$/.test(id)) return err("invalid");
  const done = await ask(app, repo, "POST", `/jobs/runs/${id}/${action}`, reach);
  if (!done.ok) return err(done.error);
  // The same event a schedule's steering is, so every door already listening redraws.
  app.bus.append({ kind: "schedule.steered", repoId: repo.id, actorId: writer.value.id, payload: { name: `job:${id}`, env: "production", action } });
  return ok(true);
}

/** How many job timers the app holds: what says an app has jobs without waking it. */
export function jobTimers(app: App, repo: Repo): number {
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return 0;
  return app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM timer WHERE app_id = ?1 AND kind = 'once' AND key LIKE 'job:%'").get(record.id)?.n ?? 0;
}
