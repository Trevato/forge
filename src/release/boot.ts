/**
 * Does this tree boot? `bun src/release/boot.ts` starts `src/main.ts` on a
 * scratch data directory and a free loopback port, asks `/api/v1/health`
 * until it answers as the version the image is stamped with, and stops it
 * whatever the answer. One line out, exit 0 or 1 (2 for a bad argument).
 *
 *   bun src/release/boot.ts                    an empty data directory: the
 *                                              release build (Dockerfile)
 *   bun src/release/boot.ts --from /data       a copy of a live one: the
 *                                              promote preflight (chart hook)
 *
 * 0.7.166 passed the full check from the repository and crashed at boot from
 * its image (`Cannot find module '../../scripts/smoke.ts'`); nothing had
 * started the image it was (#2652). This is that start, at build and before
 * the roll. With `--from`, the copy is the database (`VACUUM INTO`, so a
 * forge writing it beside this is read whole) and the data directory's
 * top-level files (the secret key); repositories and app data stay where
 * they are. It lives in a directory of its own under the data directory and
 * is removed in a `finally`.
 *
 * It imports nothing a release could break but the stamp it reads: the child
 * is the thing on trial, not this.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { running } from "../kernel/version.ts";
import { probeHeaders } from "../kernel/probe.ts";
import { lostPort, onFreshPort } from "../kernel/port.ts";

export const BOOT_BUDGET_MS = 120_000;
const POLL_MS = 250;
/** A scratch directory older than this was left by a killed run. */
const STALE_MS = 60 * 60 * 1000;
const SCRATCH = "boot-proof-";

export type BootProof = { ok: true; ms: number } | { ok: false; line: string };

export interface BootInput {
  /** The directory holding `src/main.ts`. */
  readonly tree: string;
  /** What `/api/v1/health` must say it is. */
  readonly version: string;
  /** The data directory the forge boots on; a scratch one, never a live one. */
  readonly dataDir: string;
  readonly budgetMs?: number;
  /** Where PATH, HOME and TMPDIR come from; the process's own unless a test says. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The line of what the child printed that says why: the first error, else the last line. */
export function why(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const line = lines.find((l) => /\berror\b/i.test(l)) ?? lines.at(-1) ?? "";
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
}

async function versionAt(port: number, probe: Record<string, string>): Promise<string | undefined> {
  try {
    // The probe, so a forge that tells strangers only `ok` still says what it runs.
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { connection: "close", ...probe },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** Start the tree on `dataDir` and wait for it to answer health as `version`; on a fresh port if another process took the first. */
export async function bootProof(input: BootInput): Promise<BootProof> {
  const entry = join(input.tree, "src", "main.ts");
  if (!existsSync(entry)) return { ok: false, line: `${input.tree} has no src/main.ts` };
  return onFreshPort((port) => bootOnPort(input, entry, port));
}

async function bootOnPort(
  input: BootInput,
  entry: string,
  port: number,
): Promise<{ result: BootProof; portLost: boolean }> {
  const host = input.env ?? process.env;
  const env: Record<string, string> = {
    PATH: host["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    FORGE_DATA: input.dataDir,
    PORT: String(port),
    FORGE_SSH_PORT: "0",
    // The crew stays off a copy of production's queue.
    FORGE_APP_ENV: "preview",
    FORGE_VERSION: input.version,
  };
  for (const key of ["HOME", "TMPDIR", "FORGE_TEST_SOCKET"]) {
    const value = host[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  const started = performance.now();
  const budget = input.budgetMs ?? BOOT_BUDGET_MS;
  const child = Bun.spawn([process.execPath, entry], {
    cwd: input.tree,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let stderr = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-8_192);
  })().catch(() => undefined);
  let last = "no answer";
  try {
    while (performance.now() - started < budget) {
      if (child.exitCode !== null) {
        await reading;
        const said = why(stderr);
        return {
          result: { ok: false, line: `exited with ${child.exitCode} before it answered health${said ? `: ${said}` : ""}` },
          portLost: lostPort(stderr),
        };
      }
      const seen = await versionAt(port, probeHeaders(input.dataDir));
      if (seen === input.version) return { result: { ok: true, ms: Math.round(performance.now() - started) }, portLost: false };
      if (seen !== undefined) last = `health answered as ${seen}`;
      await Bun.sleep(POLL_MS);
    }
    const said = why(stderr);
    return {
      result: {
        ok: false,
        line: `did not answer health as ${input.version} within ${Math.round(budget / 1000)}s (${last})${said ? `: ${said}` : ""}`,
      },
      portLost: false,
    };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}

/**
 * Copy what a forge boots on from `from` into `to`: the database, whole, as
 * of one moment, and the data directory's other top-level files.
 */
export function copyData(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith("forge.db")) continue;
    copyFileSync(join(from, entry.name), join(to, entry.name));
  }
  const live = join(from, "forge.db");
  if (!existsSync(live)) return;
  const db = new Database(live, { readonly: true });
  try {
    db.run("VACUUM INTO ?", [join(to, "forge.db")]);
  } finally {
    db.close();
  }
}

function sweepStale(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(SCRATCH)) continue;
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours: leave it.
    }
  }
}

export interface ProveBootInput {
  readonly tree: string;
  readonly version: string;
  /** A live data directory to boot a copy of; an empty one when absent. */
  readonly from?: string | undefined;
  readonly budgetMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The whole proof: a scratch directory, the copy when asked, the boot, the clean-up. */
export async function proveBoot(input: ProveBootInput): Promise<BootProof> {
  let root = input.env?.["TMPDIR"] || tmpdir();
  if (input.from !== undefined) {
    if (!existsSync(join(input.from, "forge.db")))
      return { ok: false, line: `${input.from} holds no forge.db to copy` };
    root = input.from;
    sweepStale(root);
  }
  const scratch = mkdtempSync(join(root, SCRATCH));
  try {
    const dataDir = join(scratch, "data");
    if (input.from !== undefined) copyData(input.from, dataDir);
    else mkdirSync(dataDir);
    return await bootProof({ ...input, dataDir });
  } catch (error) {
    return { ok: false, line: `could not prepare the scratch data directory: ${String(error).slice(0, 200)}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `--from <dir>` and `--budget <seconds>`, or why not. */
export function parseArgs(argv: readonly string[]): { from?: string; budgetMs: number } | string {
  let from: string | undefined;
  let budgetMs = BOOT_BUDGET_MS;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--from" && value !== undefined && value !== "") from = value;
    else if (flag === "--budget" && value !== undefined && /^[1-9][0-9]{0,3}$/.test(value)) budgetMs = Number(value) * 1000;
    else return "usage: bun src/release/boot.ts [--from <data dir>] [--budget <seconds, 1 to 9999>]";
    i++;
  }
  return from === undefined ? { budgetMs } : { from, budgetMs };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    process.exit(2);
  }
  const { version } = running();
  const tree = join(import.meta.dir, "..", "..");
  const result = await proveBoot({ tree, version, ...args });
  const what = args.from === undefined ? "an empty data directory" : `a copy of ${args.from}`;
  if (result.ok) console.log(`boot ok: ${version} answered health on ${what} in ${result.ms}ms`);
  else console.error(`boot failed: ${version} on ${what} ${result.line}`);
  process.exit(result.ok ? 0 : 1);
}
