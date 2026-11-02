/**
 * A green release takes over the listening port (#1663).
 *
 * The way: SO_REUSEPORT on the port. Both processes bind it (`reusePort` in
 * `serve`), the kernel hands each new connection to one of them, and the old
 * one is drained as a SIGTERM drains it today. Fd passing on a unix socket
 * would need the platform's router to speak it and a listener Bun cannot
 * adopt; the port is what the platform and the checks already dial, and
 * nothing is torn down between the two listeners, so no connection finds the
 * port closed.
 *
 * The new process is started from `releases/<sha>/`, told its commit
 * (`FORGE_COMMIT`), and asked `/api/v1/health` until an answer names that
 * commit and says `ok`. Any answer from the old process names another, so
 * only the new one can satisfy the read. A new process that does not within
 * its budget is stopped and the old keeps serving.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeServing } from "./serving.ts";

export const SWAP_BUDGET_MS = 60_000;
const POLL_MS = 250;

export type Swapped = { ok: true; pid: number } | { ok: false; line: string };

export interface SwapInput {
  /** `releases/<sha>/`. */
  dir: string;
  sha: string;
  port: number;
  /** The environment the new forge starts with: the old one's, as it is. */
  env: Record<string, string | undefined>;
  budgetMs?: number;
  /** The version the new process runs as (`FORGE_VERSION`); the environment's own when absent. */
  version?: string;
  /** Sent with each health read (`kernel/probe.ts`), so the answer names its commit. */
  probe?: Readonly<Record<string, string>>;
}

/** Whether `body` is a health answer from `sha` that is well and not leaving. */
export function healthyAs(body: unknown, sha: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const h = body as { ok?: unknown; commit?: unknown; draining?: unknown };
  return h.ok === true && h.draining !== true && h.commit === sha;
}

async function readHealth(port: number, probe: Readonly<Record<string, string>>): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { connection: "close", ...probe },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** Start the release beside the running forge and wait for it to say it is well. */
export async function startRelease(input: SwapInput): Promise<Swapped> {
  const entry = join(input.dir, "src", "main.ts");
  if (!existsSync(entry)) return { ok: false, line: "the tree has no src/main.ts" };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) if (v !== undefined) env[k] = v;
  env["FORGE_COMMIT"] = input.sha;
  if (input.version !== undefined) env["FORGE_VERSION"] = input.version;
  env["PORT"] = String(input.port);
  env["FORGE_SELF_SWAP"] = "1";
  const proc = Bun.spawn([process.execPath, entry], {
    cwd: input.dir,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  let exited: number | undefined;
  void proc.exited.then((code) => {
    exited = code;
  });
  const deadline = Date.now() + (input.budgetMs ?? SWAP_BUDGET_MS);
  while (Date.now() < deadline) {
    if (exited !== undefined)
      return { ok: false, line: `the new process exited with ${exited} before it was healthy` };
    if (healthyAs(await readHealth(input.port, input.probe ?? {}), input.sha)) {
      proc.unref();
      // The launcher of a container waits on this pid now (`serving.ts`).
      if (env["FORGE_DATA"]) writeServing(env["FORGE_DATA"], { pid: proc.pid, sha: input.sha });
      return { ok: true, pid: proc.pid };
    }
    await Bun.sleep(POLL_MS);
  }
  proc.kill("SIGKILL");
  await proc.exited;
  return {
    ok: false,
    line: `the new process was not healthy within ${Math.round((input.budgetMs ?? SWAP_BUDGET_MS) / 1000)}s`,
  };
}

/**
 * How long a process that handed its port over keeps answering what it had
 * already taken — a long push or clone — before it goes (#2040).
 */
export const HANDOVER_INFLIGHT_MS = 300_000;

/**
 * The drain a handover runs (#2040). The release listens on this port too,
 * so this process stops accepting at once: every new connection is the
 * release's. What is in flight here is answered to the end (up to
 * `budgetMs`) beside `rest` — the shutdown's other steps — and only once
 * both are done does `close` cut what remains. Runs once.
 */
export function drainOnHandover(
  servers: { stopAccepting(budgetMs: number): Promise<void> },
  rest: () => Promise<unknown>,
  close: () => void,
  budgetMs = HANDOVER_INFLIGHT_MS,
): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () =>
    (done ??= (async () => {
      const inFlight = servers.stopAccepting(budgetMs);
      await Promise.all([inFlight, rest()]).catch(() => {});
      close();
    })());
}

/**
 * What the running forge does once the release is well: drain, as a SIGTERM
 * does, but letting go of the port first (`drainOnHandover`). Set at boot,
 * with whether this process holds the SSH listener (a new process cannot
 * bind that port while this one does, and a release must not quietly close
 * the terminal).
 */
export const handover: { drain?: () => void; ssh?: boolean; migrate?: boolean } = {};

const MIGRATE_SYSCTL = "/proc/sys/net/ipv4/tcp_migrate_req";

/**
 * Whether the kernel moves connections waiting in a closing listener's accept
 * queue to another listener of the group (Linux 5.14+, `tcp_migrate_req=1`).
 * Without it, the old process closing resets what it had not yet accepted, so
 * the swap would fail requests. `handover.migrate` stands in for the file in tests.
 */
export function migratesQueuedConnections(): boolean {
  return migrateReq() === "1";
}

/** The kernel's `tcp_migrate_req` as read: `1`, `0` (or any other value), or `unreadable`. */
export function migrateReq(): "1" | "0" | "unreadable" {
  if (handover.migrate !== undefined) return handover.migrate ? "1" : "0";
  try {
    return readFileSync(MIGRATE_SYSCTL, "utf8").trim() === "1" ? "1" : "0";
  } catch {
    return "unreadable";
  }
}

export interface SelfSwap {
  /** Whether `FORGE_SELF_SWAP=1` was set at boot. */
  readonly enabled: boolean;
  readonly migrateReq: "1" | "0" | "unreadable";
  /** Why this forge cannot swap itself; null when it can. */
  readonly blocked: string | null;
}

/**
 * Whether this forge can swap itself, as plain data for /capacity and the
 * MCP `capacity` tool (#8383): what `beginSwap` would refuse, and why, before
 * a landing is refused for it. `enabled` is the app's `selfSwap`.
 */
export function selfSwapState(enabled: boolean): SelfSwap {
  const blocked =
    swapBlocked() ??
    (enabled ? null : "FORGE_SELF_SWAP is off, so a landed release waits for a restart; set FORGE_SELF_SWAP=1 to swap");
  return { enabled, migrateReq: migrateReq(), blocked };
}

let underWay = false;

/**
 * Take the one swap this process may make. Refused while another is in its
 * budget or once one has succeeded (this process is then draining), so two
 * landings close together never leave two releases serving; and refused while
 * this process holds an SSH listener. `tell` says whether the landed pull
 * should hear of it. Refused too unless the kernel migrates queued connections
 * between listeners of the port.
 *
 * The release is a child of this process, not detached: the swap is for a forge
 * run directly, not under a supervisor (PID 1 of a container, a systemd unit
 * with KillMode=control-group) whose old process exiting takes the release too.
 */
export function beginSwap(): { ok: true } | { ok: false; line: string; tell: boolean } {
  if (underWay)
    return { ok: false, line: "a swap is already under way or done in this process", tell: false };
  const blocked = swapBlocked();
  if (blocked !== undefined) return { ok: false, line: blocked, tell: true };
  underWay = true;
  return { ok: true };
}

/** Why this process cannot swap at all (SSH held, queued connections not migrated); undefined when it can. */
export function swapBlocked(): string | undefined {
  if (handover.ssh === true)
    return "this process holds the SSH terminal, which a new process cannot take over yet; restart the forge to run this tree";
  if (!migratesQueuedConnections())
    return "the kernel would reset connections queued on the old listener when it closes; set net.ipv4.tcp_migrate_req=1 (Linux 5.14+) to swap, or restart the forge to run this tree";
  return undefined;
}

/** A swap that failed gives the turn back; one that worked keeps it, for this process is leaving. */
export function endSwap(swapped: boolean): void {
  if (!swapped) underWay = false;
}
