/**
 * The image's first process (#2652): start this image's forge, and if it
 * does not answer health as its own version within the grace, start the
 * last version that did instead.
 *
 * A version that reads ready is copied onto the volume
 * (`release/good/<version>/`: its `src/` and the two files beside it) and
 * named in `release/good.json`; the one before it is removed. A version
 * that exits first, or is still not ready when the grace runs out, is
 * stopped, `release/rolled-back.json` says what happened, and the kept tree
 * runs under its own stamp. The forge that comes up reads that record: a
 * card while it stands (`kernel/vitals.ts`) and a page to the admins once
 * (`crew/notify.ts`). The next version that reads ready clears it.
 *
 * 0.7.166 crash-looped for two hours because the old pod was gone and
 * nothing undid the roll; with this, the same image serves the old version
 * seconds after its crash, and a hang costs the grace (150 s, inside the
 * chart's three-minute startup probe).
 *
 * Node built-ins only, on purpose: it is the one part of a bad release that
 * has to work.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

export const READY_GRACE_MS = 150_000;
const POLL_MS = 500;
/** How long a stopped release has to exit before it is killed. */
const STOP_MS = 10_000;
/** What a kept tree is: what the Dockerfile copies into the image. */
const TREE_PARTS = ["src", "package.json", "tsconfig.json"];
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export interface Good {
  readonly version: string;
  readonly commit: string | null;
  readonly at: string;
}

export interface RolledBack {
  /** The version that did not become ready. */
  readonly from: string;
  /** The version running in its place. */
  readonly to: string;
  readonly at: string;
  readonly why: string;
  /** Whether the admins were told; set once by the forge that told them. */
  readonly paged: boolean;
}

const releaseDir = (dataDir: string): string => join(dataDir, "release");
const goodFile = (dataDir: string): string => join(releaseDir(dataDir), "good.json");
const rolledFile = (dataDir: string): string => join(releaseDir(dataDir), "rolled-back.json");
export const goodTree = (dataDir: string, version: string): string => join(releaseDir(dataDir), "good", version);

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** The last version that read ready, while its tree is kept. */
export function lastGood(dataDir: string): Good | undefined {
  const g = readJson(goodFile(dataDir));
  const version = g?.["version"];
  if (typeof version !== "string" || !VERSION.test(version) || typeof g?.["at"] !== "string") return undefined;
  if (!existsSync(join(goodTree(dataDir, version), "src", "main.ts"))) return undefined;
  return { version, commit: typeof g["commit"] === "string" ? g["commit"] : null, at: g["at"] };
}

/** Keep `tree` as the last good release; drop the one it replaces and any standing rollback. */
export function keepGood(dataDir: string, tree: string, version: string, commit: string | null, now = Date.now()): void {
  if (!VERSION.test(version)) return;
  if (lastGood(dataDir)?.version !== version) {
    const target = goodTree(dataDir, version);
    const staging = `${target}.partial-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    for (const part of TREE_PARTS)
      if (existsSync(join(tree, part))) cpSync(join(tree, part), join(staging, part), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    writeJson(goodFile(dataDir), { version, commit, at: new Date(now).toISOString() });
  }
  for (const name of readdirSync(join(releaseDir(dataDir), "good")))
    if (name !== version) rmSync(join(releaseDir(dataDir), "good", name), { recursive: true, force: true });
  rmSync(rolledFile(dataDir), { force: true });
}

/** The rollback the launcher made, while it stands. */
export function rolledBack(dataDir: string): RolledBack | undefined {
  const r = readJson(rolledFile(dataDir));
  if (r === undefined) return undefined;
  const { from, to, at, why, paged } = r;
  if (typeof from !== "string" || typeof to !== "string" || typeof at !== "string" || typeof why !== "string")
    return undefined;
  return { from, to, at, why, paged: paged === true };
}

/** Record that the admins were told, so no later boot tells them again. */
export function markRollbackPaged(dataDir: string): void {
  const r = rolledBack(dataDir);
  if (r !== undefined && !r.paged) writeJson(rolledFile(dataDir), { ...r, paged: true });
}

/** The card a standing rollback is. */
export function rollbackNeed(dataDir: string): { sentence: string; since: string } | undefined {
  const r = rolledBack(dataDir);
  if (r === undefined) return undefined;
  return { sentence: `Release ${r.from} did not become ready (${r.why}); rolled back to ${r.to}.`, since: r.at };
}

async function versionAt(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

const gone = (child: Subprocess): boolean => child.exitCode !== null || child.signalCode !== null;

async function stop(child: Subprocess): Promise<void> {
  if (gone(child)) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
  await child.exited;
  clearTimeout(timer);
}

export interface LaunchInput {
  /** This image's tree: the directory holding `src/main.ts`. */
  readonly tree: string;
  readonly dataDir: string;
  readonly port: number;
  /** What this image is stamped as, and what its health must answer. */
  readonly version: string;
  readonly commit: string | null;
  /** The environment either forge starts with. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly graceMs?: number;
  readonly now?: () => number;
  /** Told of each process started, so a signal reaches the one running. */
  readonly started?: (child: Subprocess) => void;
  /** True once the launcher was asked to stop: a release exiting then is no failure. */
  readonly stopping?: () => boolean;
}

export type Launched =
  | { readonly ran: "release" | "rollback"; readonly child: Subprocess; readonly line: string }
  | { readonly ran: "none"; readonly line: string };

function start(input: LaunchInput, tree: string, version: string, commit: string | null): Subprocess {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) if (v !== undefined) env[k] = v;
  env["FORGE_VERSION"] = version;
  env["FORGE_COMMIT"] = commit ?? "";
  const child = Bun.spawn([process.execPath, join(tree, "src", "main.ts")], {
    cwd: tree,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  input.started?.(child);
  return child;
}

/**
 * Start this image's forge and answer once it is ready (`release`), was
 * replaced by the last good one (`rollback`), or neither runs (`none`).
 * The child returned is the one to wait on.
 */
export async function launch(input: LaunchInput): Promise<Launched> {
  const now = input.now ?? Date.now;
  const grace = input.graceMs ?? READY_GRACE_MS;
  const release = start(input, input.tree, input.version, input.commit);
  const began = now();
  let why: string;
  for (;;) {
    if (input.stopping?.()) return { ran: "none", line: "asked to stop before it was ready" };
    if (gone(release)) {
      why = `it exited with ${release.exitCode ?? release.signalCode} before it was ready`;
      break;
    }
    if ((await versionAt(input.port)) === input.version) {
      try {
        keepGood(input.dataDir, input.tree, input.version, input.commit, now());
      } catch (error) {
        // Serving matters more than keeping: the next version falls back to the one before.
        return { ran: "release", child: release, line: `${input.version} is ready; not kept: ${String(error).slice(0, 200)}` };
      }
      return { ran: "release", child: release, line: `${input.version} is ready and kept as the last good release` };
    }
    if (now() - began >= grace) {
      why = `not ready within ${Math.round(grace / 1000)}s`;
      break;
    }
    await Bun.sleep(POLL_MS);
  }
  await stop(release);
  if (input.stopping?.()) return { ran: "none", line: "asked to stop before it was ready" };
  const good = lastGood(input.dataDir);
  if (good === undefined || good.version === input.version)
    return { ran: "none", line: `${input.version}: ${why}; no earlier release is kept to roll back to` };
  writeJson(rolledFile(input.dataDir), {
    from: input.version,
    to: good.version,
    at: new Date(now()).toISOString(),
    why,
    paged: false,
  } satisfies RolledBack);
  const child = start(input, goodTree(input.dataDir, good.version), good.version, good.commit);
  return { ran: "rollback", child, line: `${input.version}: ${why}; rolled back to ${good.version}` };
}

if (import.meta.main) {
  const env = process.env;
  const version = (env["FORGE_VERSION"] ?? "").trim().replace(/^v(?=\d)/, "");
  const commit = (env["FORGE_COMMIT"] ?? "").trim();
  const graceS = Number(env["FORGE_READY_GRACE_S"] ?? "");
  let current: Subprocess | undefined;
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      stopping = true;
      current?.kill(signal);
    });
  const launched = await launch({
    tree: join(import.meta.dir, "..", ".."),
    dataDir: env["FORGE_DATA"] || "data",
    port: Number(env["PORT"] ?? 3000),
    version: VERSION.test(version) ? version : "dev",
    commit: commit === "" ? null : commit,
    env,
    ...(Number.isInteger(graceS) && graceS > 0 ? { graceMs: graceS * 1000 } : {}),
    started: (child) => {
      current = child;
    },
    stopping: () => stopping,
  });
  console.error(`launch: ${launched.line}`);
  process.exit(launched.ran === "none" ? (stopping ? 0 : 1) : await launched.child.exited);
}
