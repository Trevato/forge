/**
 * The dead-man probe: a read of the bucket and of the forge from outside
 * the serving process. The in-process bucket check goes quiet with the
 * forge, so a dead forge looked like a forge with nothing to report. This
 * goes red when either is silent: the forge does not answer `/healthz`, or
 * the newest snapshot in the store is older than it should be (one a night,
 * so 36 h leaves a retry hour and a late start). Plain data in, plain data
 * out; `scripts/backup-probe.ts` is the process that runs it.
 */

import { listSnapshots } from "./snapshot.ts";
import type { Store } from "./store.ts";

/** One nightly plus a day-and-a-half's grace: older than this is a missed night. */
export const MAX_AGE_MS = 36 * 3_600_000;
/** How long the forge may take to answer before it counts as silent. */
export const FORGE_TIMEOUT_MS = 10_000;

export interface Finding {
  readonly what: "forge" | "bucket";
  readonly ok: boolean;
  /** One plain line; never a secret. */
  readonly detail: string;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
}

export interface ProbeDeps {
  /** The bucket to read; undefined is itself red: nothing is watching a backup that has nowhere to land. */
  readonly store: Store | undefined;
  /** The forge's base URL; its `/healthz` is read. */
  readonly forgeUrl: string | undefined;
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly fetch?: (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<{ status: number }>;
  readonly timeoutMs?: number;
}

/** A finish time this far ahead of the clock is a bad clock or manifest, not a fresh snapshot. */
export const FUTURE_SLACK_MS = 5 * 60_000;

const hours = (ms: number): string => `${Math.round(ms / 360_000) / 10} h`;

export async function probeBucket(store: Store | undefined, now: number, maxAgeMs: number): Promise<Finding> {
  if (store === undefined) return { what: "bucket", ok: false, detail: "no store to read" };
  try {
    const newest = (await listSnapshots(store))[0];
    if (newest === undefined) return { what: "bucket", ok: false, detail: `${store.where} holds no snapshot` };
    const at = Date.parse(newest.finishedAt);
    if (!Number.isFinite(at)) return { what: "bucket", ok: false, detail: `${newest.name} has no readable finish time` };
    const age = now - at;
    if (age < -FUTURE_SLACK_MS) return { what: "bucket", ok: false, detail: `${newest.name} finished in the future (${hours(-age)} ahead of this clock)` };
    return age > maxAgeMs
      ? { what: "bucket", ok: false, detail: `newest snapshot ${newest.name} is ${hours(age)} old; the limit is ${hours(maxAgeMs)}` }
      : { what: "bucket", ok: true, detail: `newest snapshot ${newest.name} is ${hours(age)} old` };
  } catch (error) {
    return { what: "bucket", ok: false, detail: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function probeForge(
  url: string | undefined,
  doFetch: NonNullable<ProbeDeps["fetch"]>,
  timeoutMs: number,
): Promise<Finding> {
  if (url === undefined) return { what: "forge", ok: false, detail: "no forge URL to read" };
  let target: string;
  try {
    const u = new URL("/healthz", url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http");
    target = u.href;
  } catch {
    return { what: "forge", ok: false, detail: "the forge URL is not an http(s) URL" };
  }
  try {
    const res = await doFetch(target, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    // Redirects are not followed: another host answering 200 is not the forge being up.
    return res.status === 200
      ? { what: "forge", ok: true, detail: `${new URL(target).host} answers /healthz` }
      : { what: "forge", ok: false, detail: `${new URL(target).host} answered /healthz with ${res.status}` };
  } catch {
    return { what: "forge", ok: false, detail: `${new URL(target).host} did not answer /healthz` };
  }
}

/** Both reads, always both: a dead forge must not hide a stale bucket. */
export async function probe(deps: ProbeDeps): Promise<ProbeResult> {
  const [bucket, forge] = await Promise.all([
    probeBucket(deps.store, deps.now ?? Date.now(), deps.maxAgeMs ?? MAX_AGE_MS),
    probeForge(deps.forgeUrl, deps.fetch ?? ((u, i) => fetch(u, i)), deps.timeoutMs ?? FORGE_TIMEOUT_MS),
  ]);
  return { ok: bucket.ok && forge.ok, findings: [forge, bucket] };
}

export interface ProbeArgs {
  readonly forgeUrl: string | undefined;
  readonly dir: string | undefined;
  readonly maxAgeMs: number;
}

/** The CLI's flags: `--forge <url>`, `--dir <path>`, `--max-age-hours <n>`. A flag without its value, or an unknown one, is an error. */
export function parseProbeArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): ProbeArgs | { readonly error: string } {
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    if (name !== "--forge" && name !== "--dir" && name !== "--max-age-hours") return { error: `unknown argument ${name}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value` };
    got[name] = value;
  }
  const hours = got["--max-age-hours"] === undefined ? MAX_AGE_MS / 3_600_000 : Number(got["--max-age-hours"]);
  if (!Number.isFinite(hours) || hours <= 0) return { error: "--max-age-hours must be a positive number" };
  return { forgeUrl: got["--forge"] ?? (env["FORGE_URL"] || undefined), dir: got["--dir"], maxAgeMs: hours * 3_600_000 };
}
