/**
 * The roll rehearsal (#873, `docs/ops/ROLL.md` step 3): roll a copy of the
 * forge the way the chart rolls the real one, with requests running the
 * whole time, and count every request a person would have seen refused.
 *
 *   bun scripts/rehearse-roll.ts [--from <data dir>] [--old <checkout>]
 *     [--new <checkout>] [--seconds 60] [--probe-ms 5000] [--linger 10]
 *     [--concurrency 4] [--paths /,/healthz,/explore] [--json]
 *
 *   0  zero refused: the roll stays up
 *   1  a request was refused, or nothing rolled
 *   2  an argument is wrong, or a forge would not start
 *
 * `--from` is copied, never served: point it at a restored snapshot
 * (`docs/RESTORE.md`), not at the live data directory. Without it the
 * forges share a fresh, empty one. `--old` and `--new` are forge checkouts
 * (the release rolled from, the release rolled to); both default to this
 * one. The forges run with SSH, apps and checks off and a child's short
 * environment, never this shell's.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, lostPort, PORT_RETRIES } from "../src/kernel/port.ts";
import {
  count,
  emptyTally,
  type ForgeSeen,
  goneLine,
  judge,
  parseArgs,
  report,
  Rotation,
  type Outcome,
  type ProbeAnswer,
  type RehearsalArgs,
  type Timeline,
  type Verdict,
} from "./rehearsal.ts";

interface Forge {
  readonly name: "old" | "new";
  readonly port: number;
  readonly url: string;
  readonly proc: Bun.Subprocess;
  readonly log: string;
  readonly startedAt: number;
  /** Fresh ports this forge was started on after losing one (`kernel/port.ts`). */
  readonly portsLost: number;
}

/**
 * A forge on a port free a moment ago. Between the probe that found it and
 * the forge's bind, another process can take it — a gate shard's listener,
 * or one of the thousands of outgoing connections a roll makes.
 */
async function start(
  name: Forge["name"],
  checkout: string,
  dataDir: string,
  lingerS: number,
  logDir: string,
  portsLost = 0,
): Promise<Forge> {
  const port = await freePort();
  const log = join(logDir, `${name}-${portsLost}.log`);
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    FORGE_DATA: dataDir,
    PORT: String(port),
    FORGE_SSH_PORT: "0",
    FORGE_APPS: "0",
    FORGE_CHECKS: "0",
    FORGE_DRAIN_LINGER_S: String(lingerS),
  };
  for (const pass of ["TMPDIR", "FORGE_TEST_SOCKET"]) {
    const v = process.env[pass];
    if (v !== undefined) env[pass] = v;
  }
  const proc = Bun.spawn([process.execPath, join(checkout, "src", "main.ts")], {
    cwd: checkout,
    env,
    stdin: "ignore",
    stdout: Bun.file(log),
    stderr: Bun.file(`${log}.err`),
  });
  return { name, port, url: `http://127.0.0.1:${port}`, proc, log, startedAt: Date.now(), portsLost };
}

const gone = (forge: Forge): boolean =>
  forge.proc.exitCode !== null || forge.proc.signalCode !== null;

/** What the forge wrote: its stderr, or its log when stderr is empty. */
async function said(forge: Forge): Promise<string> {
  const read = (path: string): Promise<string> => Bun.file(path).text().catch(() => "");
  const err = await read(`${forge.log}.err`);
  return err.trim() !== "" ? err : read(forge.log);
}

/** Whether a gone forge only lost its port, and has a retry left to take a fresh one. */
async function retriable(forge: Forge): Promise<boolean> {
  return forge.portsLost < PORT_RETRIES && gone(forge) && lostPort(await said(forge));
}

/** The error a gone forge raises: process, port, wait and its last words. */
async function goneError(forge: Forge): Promise<Error> {
  return new Error(
    goneLine({
      name: forge.name,
      pid: forge.proc.pid,
      port: forge.port,
      exitCode: forge.proc.exitCode,
      signal: forge.proc.signalCode,
      waitedMs: Date.now() - forge.startedAt,
      portsLost: forge.portsLost,
      output: await said(forge),
      log: forge.log,
    }),
  );
}

/** One readiness probe: ready, not ready (a 503, or nothing listening), or silent past its timeout. */
async function probe(forge: Forge, timeoutMs: number): Promise<ProbeAnswer> {
  try {
    const res = await fetch(`${forge.url}/readyz`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return res.status === 200 ? "ready" : "not-ready";
  } catch (error) {
    return errorCode(error) === "TimeoutError" ? "silent" : "not-ready";
  }
}

async function ready(forge: Forge, timeoutMs: number): Promise<boolean> {
  return (await probe(forge, timeoutMs)) === "ready";
}

/** The client's name for what went wrong: "ConnectionRefused", "TimeoutError"… */
function errorCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "TimeoutError";
  return typeof e?.code === "string" ? e.code : String(e?.name ?? "Error");
}

/**
 * One request. A connection refused or cut is "refused"; one the forge
 * held open past the client's patience is "slow" — the machine, not the
 * roll (#2453).
 */
async function ask(url: string): Promise<{ outcome: Outcome; code: string | null }> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await res.arrayBuffer();
    return { outcome: res.status, code: null };
  } catch (error) {
    const code = errorCode(error);
    return { outcome: code === "TimeoutError" ? "slow" : "refused", code };
  }
}

/** Run one rehearsal and judge it. Throws only when a forge will not start. */
export async function rehearse(
  args: RehearsalArgs,
  say: (line: string) => void = () => {},
): Promise<Verdict & { logs: string }> {
  const work = mkdtempSync(join(tmpdir(), "forge-rehearsal-"));
  const dataDir = join(work, "data");
  const logs = join(work, "logs");
  mkdirSync(logs);
  if (args.from === null) mkdirSync(dataDir);
  else cpSync(resolve(args.from), dataDir, { recursive: true });

  const rotation = new Rotation<Forge>();
  const tally = emptyTally();
  const timeline: Timeline = { newInRotationMs: null, oldOutOfRotationMs: null, oldExitMs: null };
  const forges: Forge[] = [];
  try {
    let old = await start("old", resolve(args.old), dataDir, args.lingerS, logs);
    forges.push(old);
    say(`old forge starting at ${old.url}`);
    const bootBy = Date.now() + 60_000;
    while (!(await ready(old, 1000))) {
      if (await retriable(old)) {
        say(`old forge lost port ${old.port} to another process; starting it on a fresh one`);
        old = await start("old", resolve(args.old), dataDir, args.lingerS, logs, old.portsLost + 1);
        forges[0] = old;
        continue;
      }
      if (gone(old) || Date.now() > bootBy) throw await goneError(old);
      await Bun.sleep(100);
    }
    rotation.saw(old, true);
    say("old forge in rotation; requests start");

    const began = Date.now();
    const until = began + args.seconds * 1000;
    let termAt: number | null = null;
    // Each process as a miss saw it: whether it still ran, and was told to go.
    const states = (): Record<string, string> =>
      Object.fromEntries(
        forges.map((f) => [
          f.name,
          f.proc.exitCode !== null ? "exited" : f === old && termAt !== null ? "draining" : "serving",
        ]),
      );

    const load = async (lane: number): Promise<void> => {
      for (let i = lane; Date.now() < until; i += args.concurrency) {
        const forge = rotation.next();
        if (forge === null) {
          count(tally, null, "nobody", { atMs: Date.now() - began, code: null, forges: states() });
          await Bun.sleep(10);
          continue;
        }
        const path = args.paths[i % args.paths.length] ?? "/";
        const { outcome, code } = await ask(forge.url + path);
        count(tally, forge.name, outcome, { atMs: Date.now() - began, code, forges: states() });
      }
    };

    // The platform's side: probe every forge each period, start the new
    // one beside the old, and signal the old one once the new is ready.
    const roll = async (): Promise<void> => {
      await Bun.sleep(Math.min(2000, (args.seconds * 1000) / 4));
      let next = await start("new", resolve(args.next), dataDir, args.lingerS, logs);
      forges.push(next);
      say(`new forge starting at ${next.url}`);
      old.proc.exited.then(() => {
        if (termAt !== null) timeline.oldExitMs = Date.now() - termAt;
      });
      while (Date.now() < until) {
        for (const forge of forges) {
          const answer = await probe(forge, Math.min(1000, args.probeMs));
          const was = rotation.has(forge);
          rotation.saw(forge, answer);
          const up = rotation.has(forge);
          if (up !== was)
            say(`${forge.name} forge ${up ? "joins" : "leaves"} rotation at ${Date.now() - began} ms: probe ${answer}`);
          // Signalled once: a new forge that leaves and rejoins is not a second roll.
          if (forge === next && up && !was && termAt === null) {
            timeline.newInRotationMs = Date.now() - began;
            say("new forge in rotation; the old one is sent SIGTERM");
            termAt = Date.now();
            old.proc.kill("SIGTERM");
          }
          if (forge === old && !up && was && termAt !== null) {
            timeline.oldOutOfRotationMs = Date.now() - termAt;
            say("old forge out of rotation");
          }
        }
        // A new forge that never joined lost only its port; one that did is the roll's failure.
        if (termAt === null && !rotation.has(next) && (await retriable(next))) {
          say(`new forge lost port ${next.port} to another process; starting it on a fresh one`);
          const again = await start("new", resolve(args.next), dataDir, args.lingerS, logs, next.portsLost + 1);
          forges[forges.indexOf(next)] = again;
          next = again;
        } else if (gone(next)) throw await goneError(next);
        await Bun.sleep(args.probeMs);
      }
    };

    await Promise.all([
      roll(),
      ...Array.from({ length: args.concurrency }, (_, lane) => load(lane)),
    ]);
    // A drain that outlives the requests still counts as an exit.
    if (termAt !== null && timeline.oldExitMs === null) {
      await Promise.race([old.proc.exited, Bun.sleep(args.lingerS * 1000 + 30_000)]);
      if (old.proc.exitCode !== null) timeline.oldExitMs = Date.now() - termAt;
    }
    // What each forge left, so a roll that rolled nothing names where and why.
    const seenOf = async (f: Forge | undefined, since: number | null): Promise<ForgeSeen | undefined> =>
      f === undefined
        ? undefined
        : { port: f.port, portsLost: f.portsLost, waitedMs: Date.now() - (since ?? f.startedAt), output: await said(f) };
    const seen: Partial<Record<Forge["name"], ForgeSeen>> = {};
    const oldSeen = await seenOf(forges.find((f) => f.name === "old"), termAt);
    const newSeen = await seenOf(forges.find((f) => f.name === "new"), null);
    if (oldSeen !== undefined) seen.old = oldSeen;
    if (newSeen !== undefined) seen.new = newSeen;
    return { ...judge(tally, timeline, seen), logs };
  } finally {
    for (const f of forges) if (f.proc.exitCode === null) f.proc.kill("SIGKILL");
    await Promise.all(forges.map((f) => f.proc.exited));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  let args: RehearsalArgs;
  try {
    args = parseArgs(process.argv.slice(2), resolve(import.meta.dir, ".."));
  } catch (error) {
    console.error(`rehearse-roll: ${(error as Error).message}`);
    process.exit(2);
  }
  try {
    const v = await rehearse(args, args.json ? undefined : (l) => console.log(`· ${l}`));
    console.log(args.json ? JSON.stringify(v) : `${report(v)}\nlogs       ${v.logs}`);
    process.exit(v.ok ? 0 : 1);
  } catch (error) {
    console.error(`rehearse-roll: ${(error as Error).message}`);
    process.exit(2);
  }
}
