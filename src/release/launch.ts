/**
 * The image's first process (#2652): start this image's forge, and if it
 * does not answer health as its own version within the grace, start the
 * last version that did instead.
 *
 * A version that reads ready is copied onto the volume
 * (`release/good/<version>/`: its `src/` and the two files beside it) and
 * named in `release/good.json`; the one before it is removed. A version
 * that exits first, or is still not ready when the grace runs out, is
 * stopped, `release/rolled-back.json` says what happened and what the
 * release last said on stderr (#10249: 0.7.481 left only "it exited with 1"),
 * and the kept tree runs under its own stamp. The forge that comes up reads that record: a
 * card while it stands (`kernel/vitals.ts`) and a page to the admins once
 * (`crew/notify.ts`). The next version that reads ready clears it.
 *
 * 0.7.166 crash-looped for two hours because the old pod was gone and
 * nothing undid the roll; with this, the same image serves the old version
 * seconds after its crash, and a hang costs the grace (150 s, inside the
 * chart's three-minute startup probe).
 *
 * A swapped release (#8042) is a good tree too: the keeper that verified it
 * keeps it with `base`, the image version it was swapped over. On a restart
 * of that same image the launcher starts the swapped tree first, so an older
 * image never silently rolls production back; only a different image (a
 * deliberate roll) takes precedence, and a swapped tree that is not ready in
 * the grace falls back to the image, recorded as any rollback is. The
 * process that took over is not the launcher's child; `serving.ts` names it
 * and the launcher stays up as long as it does.
 *
 * Node built-ins only, on purpose: it is the one part of a bad release that
 * has to work.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { hkdfSync } from "node:crypto";
import { clearServing, follow, signalServing } from "./serving.ts";

export const READY_GRACE_MS = 150_000;
const POLL_MS = 500;
/** How long a stopped release has to exit before it is killed. */
const STOP_MS = 10_000;
/** What a kept tree is: what the Dockerfile copies into the image. */
const TREE_PARTS = ["src", "package.json", "tsconfig.json"];
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
/** How much of a release's stderr is kept, to say why it did not become ready. */
const TAIL_BYTES = 8_192;
/** How long a release that exited has to finish writing its last words. */
const LAST_WORDS_MS = 1_000;
/** How long the last words in the record may be. */
const SAID_MAX = 200;

export interface Good {
  readonly version: string;
  readonly commit: string | null;
  readonly at: string;
  /** The image version this was swapped in over; null for a tree the launcher itself started. */
  readonly base: string | null;
}

export interface RolledBack {
  /** The version that did not become ready. */
  readonly from: string;
  /** The version running in its place. */
  readonly to: string;
  readonly at: string;
  readonly why: string;
  /** The release's last error line on stderr, when it wrote one: what a person reads to fix it. */
  readonly said: string | null;
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
  const base = g["base"];
  return {
    version,
    commit: typeof g["commit"] === "string" ? g["commit"] : null,
    at: g["at"],
    base: typeof base === "string" && VERSION.test(base) ? base : null,
  };
}

/** Keep `tree` as the last good release; drop the one it replaces and any standing rollback. */
export function keepGood(
  dataDir: string,
  tree: string,
  version: string,
  commit: string | null,
  now = Date.now(),
  base: string | null = null,
): void {
  if (!VERSION.test(version) || (base !== null && !VERSION.test(base))) return;
  const kept = lastGood(dataDir);
  if (kept?.version !== version || kept.commit !== commit || kept.base !== base) {
    const target = goodTree(dataDir, version);
    const staging = `${target}.partial-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    for (const part of TREE_PARTS)
      if (existsSync(join(tree, part))) cpSync(join(tree, part), join(staging, part), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    writeJson(goodFile(dataDir), { version, commit, at: new Date(now).toISOString(), base });
  }
  for (const name of readdirSync(join(releaseDir(dataDir), "good")))
    if (name !== version) rmSync(join(releaseDir(dataDir), "good", name), { recursive: true, force: true });
  rmSync(rolledFile(dataDir), { force: true });
}

/** The rollback the launcher made, while it stands. */
export function rolledBack(dataDir: string): RolledBack | undefined {
  const r = readJson(rolledFile(dataDir));
  if (r === undefined) return undefined;
  const { from, to, at, why, said, paged } = r;
  if (typeof from !== "string" || typeof to !== "string" || typeof at !== "string" || typeof why !== "string")
    return undefined;
  return { from, to, at, why, said: typeof said === "string" && said !== "" ? said : null, paged: paged === true };
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
  const said = r.said === null ? "" : ` It said: ${r.said}`;
  return { sentence: `Release ${r.from} did not become ready (${r.why}); rolled back to ${r.to}.${said}`, since: r.at };
}

/**
 * The line of a release's stderr that says why it stopped: the last error
 * line (`error: …`, `SQLiteError: …`) when there is one, else the last line
 * that is not a stack frame, a source excerpt or Bun's version banner.
 */
export function lastWords(stderr: string): string | null {
  const lines = stderr
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^at\s/.test(line) && !/^Bun v\d/.test(line) && !/^\d+\s*\|/.test(line) && !/^\^+$/.test(line));
  const line = lines.findLast((l) => /^(?:\w*Error|error)(?::|\s|$)/.test(l)) ?? lines.at(-1);
  if (line === undefined) return null;
  return line.length > SAID_MAX ? `${line.slice(0, SAID_MAX - 1)}…` : line;
}

/** A child's stderr, passed through to ours, with its tail kept until `forget`. */
interface Heard {
  readonly ended: Promise<void>;
  tail(): string;
  forget(): void;
}

function hear(stream: ReadableStream<Uint8Array>): Heard {
  let kept: Buffer | undefined = Buffer.alloc(0);
  const ended = (async () => {
    try {
      for await (const chunk of stream) {
        process.stderr.write(chunk);
        if (kept === undefined) continue;
        kept = Buffer.concat([kept, chunk]);
        if (kept.length > TAIL_BYTES) kept = kept.subarray(kept.length - TAIL_BYTES);
      }
    } catch {
      // the pipe closing under us is the child going: what was heard stands
    }
  })();
  return {
    ended,
    tail: () => kept?.toString("utf8") ?? "",
    forget: () => {
      kept = undefined;
    },
  };
}

/**
 * `kernel/probe.ts`'s `probeHeaders`, repeated: the launcher imports nothing
 * of the forge's, so a release can never break the thing that rolls it back.
 * The forge on `dataDir` tells its probe what it runs, a stranger only `ok`.
 */
export function probeHeaders(dataDir: string): Record<string, string> {
  let key: Buffer;
  try {
    key = readFileSync(join(dataDir, "secret.key"));
  } catch {
    return {};
  }
  if (key.length !== 32) return {};
  return { "x-forge-probe": Buffer.from(hkdfSync("sha256", key, "", "forge probe v1", 32)).toString("base64url") };
}

async function versionAt(port: number, probe: Record<string, string>): Promise<string | undefined> {
  try {
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

/** A release started, and what it says on stderr. */
interface Started {
  readonly child: Subprocess;
  readonly heard: Heard;
}

function start(input: LaunchInput, tree: string, version: string, commit: string | null): Started {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) if (v !== undefined) env[k] = v;
  env["FORGE_VERSION"] = version;
  env["FORGE_COMMIT"] = commit ?? "";
  // What a swap in this process's descendants is over: the image, not the tree running now.
  env["FORGE_BASE_VERSION"] = input.version;
  const child = Bun.spawn([process.execPath, join(tree, "src", "main.ts")], {
    cwd: tree,
    env,
    stdin: "ignore",
    stdout: "inherit",
    // Piped, not inherited, so a release that dies says why in the record; every byte still reaches ours.
    stderr: "pipe",
  });
  input.started?.(child);
  return { child, heard: hear(child.stderr) };
}

/** Why a release did not become ready, and the last line it wrote on stderr. */
interface NotReady {
  readonly why: string;
  readonly said: string | null;
}

/** Wait for the release to answer health as `version`: undefined once it does, else why it did not. */
async function becomesReady(input: LaunchInput, { child, heard }: Started, version: string): Promise<NotReady | undefined> {
  const now = input.now ?? Date.now;
  const grace = input.graceMs ?? READY_GRACE_MS;
  const began = now();
  for (;;) {
    if (input.stopping?.()) return { why: "asked to stop before it was ready", said: null };
    if (gone(child)) {
      await Promise.race([heard.ended, Bun.sleep(LAST_WORDS_MS)]);
      return { why: `it exited with ${child.exitCode ?? child.signalCode} before it was ready`, said: lastWords(heard.tail()) };
    }
    if ((await versionAt(input.port, probeHeaders(input.dataDir))) === version) {
      heard.forget();
      return undefined;
    }
    if (now() - began >= grace) return { why: `not ready within ${Math.round(grace / 1000)}s`, said: lastWords(heard.tail()) };
    await Bun.sleep(POLL_MS);
  }
}

/**
 * Start this image's forge and answer once it is ready (`release`), was
 * replaced by the last good one (`rollback`), or neither runs (`none`).
 * The child returned is the one to wait on. A swapped tree kept over this
 * very image goes first (see the header).
 */
export async function launch(input: LaunchInput): Promise<Launched> {
  const now = input.now ?? Date.now;
  const swapped = lastGood(input.dataDir);
  let passed: ({ version: string } & NotReady) | undefined;
  if (swapped !== undefined && swapped.base === input.version && swapped.version !== input.version) {
    const first = start(input, goodTree(input.dataDir, swapped.version), swapped.version, swapped.commit);
    const failed = await becomesReady(input, first, swapped.version);
    if (failed === undefined)
      return { ran: "release", child: first.child, line: `${swapped.version} is ready: the swapped release kept over image ${input.version}` };
    await stop(first.child);
    if (input.stopping?.()) return { ran: "none", line: "asked to stop before it was ready" };
    passed = { version: swapped.version, ...failed };
  }
  const started = start(input, input.tree, input.version, input.commit);
  const release = started.child;
  const failed = await becomesReady(input, started, input.version);
  if (failed === undefined) {
    try {
      keepGood(input.dataDir, input.tree, input.version, input.commit, now());
    } catch (error) {
      // Serving matters more than keeping: the next version falls back to the one before.
      return { ran: "release", child: release, line: `${input.version} is ready; not kept: ${String(error).slice(0, 200)}` };
    }
    // The swapped tree that would not start: the image runs in its place, and the forge says so.
    if (passed !== undefined) {
      writeJson(rolledFile(input.dataDir), {
        from: passed.version,
        to: input.version,
        at: new Date(now()).toISOString(),
        why: passed.why,
        said: passed.said,
        paged: false,
      } satisfies RolledBack);
      return { ran: "rollback", child: release, line: `${passed.version}: ${passed.why}; the image ${input.version} runs instead` };
    }
    return { ran: "release", child: release, line: `${input.version} is ready and kept as the last good release` };
  }
  const { why, said } = failed;
  await stop(release);
  if (input.stopping?.()) return { ran: "none", line: "asked to stop before it was ready" };
  const good = lastGood(input.dataDir);
  if (good === undefined || good.version === input.version || passed?.version === good.version)
    return { ran: "none", line: `${input.version}: ${why}; no earlier release is kept to roll back to` };
  writeJson(rolledFile(input.dataDir), {
    from: input.version,
    to: good.version,
    at: new Date(now()).toISOString(),
    why,
    said,
    paged: false,
  } satisfies RolledBack);
  const { child, heard } = start(input, goodTree(input.dataDir, good.version), good.version, good.commit);
  heard.forget();
  return { ran: "rollback", child, line: `${input.version}: ${why}; rolled back to ${good.version}` };
}

if (import.meta.main) {
  const env = process.env;
  const version = (env["FORGE_VERSION"] ?? "").trim().replace(/^v(?=\d)/, "");
  const commit = (env["FORGE_COMMIT"] ?? "").trim();
  const graceS = Number(env["FORGE_READY_GRACE_S"] ?? "");
  let current: Subprocess | undefined;
  let stopping = false;
  const dataHere = env["FORGE_DATA"] || "data";
  // Whatever an earlier container left names processes that are not ours.
  clearServing(dataHere);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      stopping = true;
      current?.kill(signal);
      signalServing(dataHere, signal);
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
  if (launched.ran === "none") process.exit(stopping ? 0 : 1);
  const code = await launched.child.exited;
  // A swapped release took over and the process we started has drained: this container is that
  // process's now, and goes when it does (the pod then restarts on the newest good tree).
  await follow(dataHere, launched.child.pid);
  process.exit(code);
}
