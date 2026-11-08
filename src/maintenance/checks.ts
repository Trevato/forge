/**
 * What the forge proves when it comes back from maintenance: one plain
 * function per line, each returning ok/failed and one line of detail. A probe
 * that talks to anything has a timeout of `PROBE_MS`, so boot is never held.
 */

import type { Database } from "bun:sqlite";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  /** One line of detail: what was seen, or why it failed. */
  readonly says: string;
}

/** The longest any probe waits. */
export const PROBE_MS = 2000;

const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);

export function databaseCheck(db: Database, version: string): Check {
  try {
    db.query("SELECT 1").get();
    return { name: "database", ok: true, says: `open, version ${version}` };
  } catch (error) {
    return { name: "database", ok: false, says: oneLine(`cannot be read: ${String(error)}`) };
  }
}

export const holdCheck = (lifted: boolean): Check => ({
  name: "release hold",
  ok: true,
  says: lifted ? "lifted" : "was already lifted",
});

export const dispatcherCheck = (): Check => ({ name: "crew dispatcher", ok: true, says: "unpaused" });

export const appsCheck = (count: number): Check => ({
  name: "apps",
  ok: true,
  says: `${count} on record, started by the forge's own boot`,
});

export const nightlyCheck = (lines: readonly string[]): Check => ({
  name: "nightly jobs",
  ok: true,
  says: oneLine(lines.join(" / ")),
});

export const queueCheck = (agents: number, checks: number): Check => ({
  name: "queue",
  ok: true,
  says: `${agents} crew run(s) and ${checks} check(s) waiting to start`,
});

/** How long the tunnel gets to come up after the process, and how often it is asked. */
export const TUNNEL_WINDOW_MS = 30_000;
export const TUNNEL_EVERY_MS = 3_000;

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Fetcher = (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<{ status: number }>;

/**
 * The tunnel is answering when the forge's public address returns 200 on
 * /healthz. It often comes up after the process, so it is asked again every
 * `TUNNEL_EVERY_MS` (each ask at most `PROBE_MS`) until `windowMs` is spent.
 */
export async function tunnelCheck(
  forgeUrl: string | undefined,
  fetcher: Fetcher = fetch,
  options: { windowMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Check> {
  const name = "tunnel";
  if (forgeUrl === undefined || forgeUrl === "") return { name, ok: false, says: "no public address is known to probe" };
  let origin: string;
  try {
    origin = new URL(forgeUrl).origin;
  } catch {
    return { name, ok: false, says: "the public address is not a URL" };
  }
  const windowMs = options.windowMs ?? TUNNEL_WINDOW_MS;
  const everyMs = options.everyMs ?? TUNNEL_EVERY_MS;
  const sleep = options.sleep ?? wait;
  let asked = 0;
  let last = "";
  for (let spent = 0; ; spent += everyMs) {
    asked++;
    try {
      const res = await fetcher(`${origin}/healthz`, { signal: AbortSignal.timeout(PROBE_MS), redirect: "manual" });
      if (res.status === 200) return { name, ok: true, says: `${origin} answers /healthz${asked > 1 ? ` (on try ${asked})` : ""}` };
      last = `answered /healthz with ${res.status}`;
    } catch (error) {
      last = `did not answer within ${PROBE_MS / 1000} s: ${String(error)}`;
    }
    if (spent + everyMs > windowMs) break;
    await sleep(everyMs);
  }
  return { name, ok: false, says: oneLine(`${origin} ${last}; asked ${asked} times over ${windowMs / 1000} s`) };
}

/** What the runner is asked: the checks lane, a semaphore a check must take a slot of. */
export interface Lane {
  readonly limit: number;
  acquire(): Promise<() => void>;
}

/**
 * The runner is up when its lane can hand out a slot within `PROBE_MS`: the
 * slot is taken and let go at once. That proves the lane is not wedged; it
 * does not start a check or reach a cluster, and the line says so.
 */
export async function runnerCheck(lane: Lane | undefined): Promise<Check> {
  const name = "runner";
  if (lane === undefined) return { name, ok: false, says: "the checks service is not running" };
  try {
    const release = await Promise.race([
      lane.acquire(),
      wait(PROBE_MS).then(() => {
        throw new Error(`no slot free within ${PROBE_MS / 1000} s`);
      }),
    ]);
    release();
    return { name, ok: true, says: `the checks lane hands out a slot (${lane.limit} in all); no check was started` };
  } catch (error) {
    return { name, ok: false, says: oneLine(`the checks lane did not hand out a slot: ${String(error)}`) };
  }
}

/** Every check on one line each: `ok name: says` or `FAILED name: says`. */
export const checkLine = (c: Check): string => `${c.ok ? "ok" : "FAILED"} ${c.name}: ${c.says}`;

/** What an admin is told: healthy as a whole, or what is not. */
export function checksSummary(checks: readonly Check[]): { healthy: boolean; line: string } {
  const bad = checks.filter((c) => !c.ok);
  const good = checks.filter((c) => c.ok);
  if (bad.length === 0) return { healthy: true, line: `all ${checks.length} checks passed (${good.map((c) => c.name).join(", ")})` };
  return {
    healthy: false,
    line: `${bad.length} of ${checks.length} checks FAILED: ${bad.map((c) => `${c.name} (${c.says})`).join("; ")}. Healthy: ${good.map((c) => c.name).join(", ") || "none"}`,
  };
}
