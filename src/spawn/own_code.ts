/**
 * A child forge that runs its own code (#11144). A cell child runs the
 * parent's code by default; with this on, the owner has it start from a
 * checked copy of its own `<org>/forge` main instead. One small file per
 * child under the parent's data (`own-code/<name>.json`) holds the switch,
 * the last commit that came up, and the last rollback. The parent, never the
 * child, decides what the cell runs, so the cell's limits, sandbox and egress
 * are built by the same `cellSpecFor` either way.
 *
 * A start is tried in order: the repository's main, the last commit that came
 * up, the parent's code. Each that fails its check or its health deadline is
 * written down as a rollback, and the owner's `/forges` page says so.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { runGit } from "../git/env.ts";
import type { Managed } from "./manage.ts";
import { CHILD_NAME, type PlacementKind } from "./placement.ts";

export interface Rollback {
  readonly at: string;
  /** The commit that failed (short), or empty when there was none. */
  readonly commit: string;
  readonly why: string;
  /** Where the child ran instead. */
  readonly to: "last-good" | "parent";
}

export interface OwnCode {
  readonly on: boolean;
  /** The last commit of its own code that came up healthy. */
  readonly good?: string;
  readonly rolledBack?: Rollback;
  /** A commit of its own that failed: not checked out or reported again until main moves. */
  readonly failed?: string;
}

/** Code a cell can run: where its entry file is, and the directory it must be able to read. */
export interface CodeSource {
  readonly kind: "own" | "last-good" | "parent";
  readonly commit?: string;
  readonly main: string;
  readonly root: string;
}

const dirOf = (app: App): string => join(app.config.dataDir, "own-code");
const fileOf = (app: App, name: string): string => join(dirOf(app), `${name}.json`);

export function readOwnCode(app: App, name: string): OwnCode {
  if (!CHILD_NAME.test(name)) return { on: false };
  try {
    const raw = JSON.parse(readFileSync(fileOf(app, name), "utf8")) as Record<string, unknown>;
    const rb = raw["rolledBack"] as Record<string, unknown> | undefined;
    return {
      on: raw["on"] === true,
      ...(typeof raw["good"] === "string" && /^[0-9a-f]{40}$/.test(raw["good"]) ? { good: raw["good"] } : {}),
      ...(typeof raw["failed"] === "string" && /^[0-9a-f]{40}$/.test(raw["failed"]) ? { failed: raw["failed"] } : {}),
      ...(rb !== undefined && typeof rb["at"] === "string" && typeof rb["why"] === "string"
        ? {
            rolledBack: {
              at: rb["at"],
              commit: typeof rb["commit"] === "string" ? rb["commit"] : "",
              why: rb["why"],
              to: rb["to"] === "last-good" ? "last-good" : "parent",
            },
          }
        : {}),
    };
  } catch {
    return { on: false };
  }
}

function write(app: App, name: string, state: OwnCode): void {
  mkdirSync(dirOf(app), { recursive: true });
  const path = fileOf(app, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

/** The child's own forge repository, found on disk without opening its database: `<childDir>/repos/<org>/forge.git`. */
export function ownRepoOf(childDir: string): string | undefined {
  const root = join(childDir, "repos");
  try {
    for (const org of readdirSync(root).sort()) {
      const dir = join(root, org, "forge.git");
      if (existsSync(join(dir, "HEAD"))) return dir;
    }
  } catch {
    // no repositories yet
  }
  return undefined;
}

/**
 * Turn the switch on or off for a named child. Hosted children cannot turn it
 * on, and are told why. `placement` and `childDir` come from the ledger.
 */
export function switchOwnCode(
  app: App,
  input: { readonly name: string; readonly placement: PlacementKind; readonly childDir: string; readonly on: boolean },
): Managed {
  const { name, on } = input;
  if (!CHILD_NAME.test(name)) return { ok: false, says: `no forge named ${name}` };
  const was = readOwnCode(app, name);
  if (on) {
    if (input.placement !== "cell")
      return {
        ok: false,
        says: "This forge runs inside its parent's process, so it can only run the parent's code. A forge in a cell of its own can run its own.",
      };
    if (ownRepoOf(input.childDir) === undefined) return { ok: false, says: "This forge has no forge repository of its own yet." };
    write(app, name, { ...was, on: true });
  } else {
    rmSync(join(dirOf(app), name), { recursive: true, force: true });
    write(app, name, { on: false });
  }
  app.bus.append({ kind: on ? "forge.own_code_on" : "forge.own_code_off", payload: { name } });
  return { ok: true, says: on ? `${name} will run its own forge code from its next start` : `${name} will run its parent's code from its next start` };
}

/** The most a child's repository, or its checked-out tree, may hold before the parent copies it. */
export const MAX_CODE_BYTES = 256 * 1024 * 1024;
export const MAX_CODE_FILES = 50_000;

/**
 * Walk a directory without following links: "link" when anything in it is a
 * symlink (the child's files are read by the parent, so a link could name a
 * parent file), "big" past the caps, else undefined. Stops at the first.
 */
export function walkTree(dir: string, caps = { bytes: MAX_CODE_BYTES, files: MAX_CODE_FILES }): "link" | "big" | undefined {
  let bytes = 0;
  let files = 0;
  const walk = (at: string): "link" | "big" | undefined => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return "link";
      const path = join(at, entry.name);
      if (++files > caps.files) return "big";
      if (entry.isDirectory()) {
        const found = walk(path);
        if (found !== undefined) return found;
      } else if (entry.isFile()) {
        bytes += lstatSync(path).size;
        if (bytes > caps.bytes) return "big";
      }
    }
    return undefined;
  };
  return walk(dir);
}

/**
 * What the tree must hold before a cell is started on it: no symlinks, an
 * entry that parses and a readable forge.json. The answers are fixed words;
 * nothing the child's files say is passed on.
 */
export function checkTree(root: string): string | undefined {
  try {
    const found = walkTree(root);
    if (found === "link") return "it contains a symbolic link";
    if (found === "big") return "it is too large to run";
  } catch {
    return "its files could not be read";
  }
  const main = join(root, "src", "main.ts");
  const regular = (path: string): boolean => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (!regular(main)) return "it has no src/main.ts";
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(main, "utf8"));
  } catch {
    return "src/main.ts does not parse";
  }
  if (!regular(join(root, "forge.json"))) return "forge.json is missing";
  try {
    const manifest = JSON.parse(readFileSync(join(root, "forge.json"), "utf8")) as unknown;
    if (typeof manifest !== "object" || manifest === null) return "forge.json is not an object";
  } catch {
    return "forge.json is not JSON";
  }
  return undefined;
}

const SHA = /^[0-9a-f]{40}$/;

/** The commit its own repository's main is at, or undefined. */
export async function tipOf(repo: string): Promise<string | undefined> {
  const out = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repo, timeoutMs: 10_000 });
  return out.ok && SHA.test(out.value) ? out.value : undefined;
}

/** A checked-out copy of `commit` under `own-code/<name>/<commit>`; the failure in words when it cannot be made. */
export async function checkout(app: App, name: string, repo: string, commit: string, parentModules?: string): Promise<{ ok: true; root: string } | { ok: false; why: string }> {
  if (!SHA.test(commit)) return { ok: false, why: "not a commit" };
  const root = join(dirOf(app), name, commit);
  if (existsSync(join(root, ".checked"))) return { ok: true, root };
  // The child controls its repository's size, and the copy lands in the parent's data: measure before copying.
  try {
    if (walkTree(repo) === "big") return { ok: false, why: "its repository is too large to copy" };
  } catch {
    return { ok: false, why: "its repository could not be read" };
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(dirOf(app), name), { recursive: true });
  const cloned = await runGit(["clone", "--quiet", "--no-hardlinks", "--no-checkout", repo, root], { timeoutMs: 120_000 });
  if (!cloned.ok) return { ok: false, why: "its code could not be copied" };
  const got = await runGit(["checkout", "--quiet", "--detach", commit], { cwd: root, timeoutMs: 120_000 });
  if (!got.ok) return { ok: false, why: "its code could not be checked out" };
  // Nothing of git goes into the cell: only the tree.
  rmSync(join(root, ".git"), { recursive: true, force: true });
  const bad = checkTree(root);
  if (bad !== undefined) {
    rmSync(root, { recursive: true, force: true });
    return { ok: false, why: bad };
  }
  if (parentModules !== undefined && existsSync(parentModules) && !existsSync(join(root, "node_modules")))
    symlinkSync(parentModules, join(root, "node_modules"));
  writeFileSync(join(root, ".checked"), commit);
  return { ok: true, root };
}

/** `full` is the failed commit in full, remembered so a wake does not try it, or report it, again. */
export function recordRollback(app: App, name: string, rolled: Rollback, full?: string): void {
  write(app, name, { ...readOwnCode(app, name), rolledBack: rolled, ...(full !== undefined && SHA.test(full) ? { failed: full } : {}) });
  app.bus.append({ kind: "forge.rolled_back", payload: { name, commit: rolled.commit, to: rolled.to, why: rolled.why } });
}

/** Trees a running or starting cell reads from, counted: pruning never removes one. */
const inUse = new Map<string, number>();

/** Mark a tree in use until the returned function is called. */
export function useTree(root: string): () => void {
  inUse.set(root, (inUse.get(root) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (inUse.get(root) ?? 1) - 1;
    if (left <= 0) inUse.delete(root);
    else inUse.set(root, left);
  };
}

export function recordGood(app: App, name: string, commit: string): void {
  const was = readOwnCode(app, name);
  if (was.good === commit) return;
  write(app, name, { ...was, good: commit });
  // The running commit, the one before it, and any tree a cell still reads are kept.
  const base = join(dirOf(app), name);
  try {
    for (const dir of readdirSync(base))
      if (dir !== commit && dir !== was.good && !inUse.has(join(base, dir))) rmSync(join(base, dir), { recursive: true, force: true });
  } catch {
    // nothing to prune
  }
}

/**
 * The sources a start tries, best first, the parent's last. Checkouts that
 * fail their check are rolled back here, before any cell is made.
 */
export async function sourcesFor(
  app: App,
  input: { readonly name: string; readonly childDir: string },
  parent: { readonly main: string; readonly root: string },
): Promise<CodeSource[]> {
  const fallback: CodeSource = { kind: "parent", ...parent };
  const state = readOwnCode(app, input.name);
  const repo = ownRepoOf(input.childDir);
  if (!state.on || repo === undefined) return [fallback];
  const modules = join(parent.root, "node_modules");
  const out: CodeSource[] = [];
  const tip = await tipOf(repo);
  let broke: { commit: string; why: string } | undefined;
  if (tip === undefined) broke = { commit: "", why: "its main has no commits" };
  else if (tip === state.failed) {
    // Already failed and reported: wait for main to move.
  } else {
    const made = await checkout(app, input.name, repo, tip, modules);
    if (made.ok) out.push({ kind: "own", commit: tip, main: join(made.root, "src", "main.ts"), root: made.root });
    else broke = { commit: tip, why: made.why };
  }
  const good = state.good;
  if (good !== undefined && good !== tip) {
    const goodTree = join(dirOf(app), input.name, good);
    if (existsSync(join(goodTree, ".checked"))) out.push({ kind: "last-good", commit: good, main: join(goodTree, "src", "main.ts"), root: goodTree });
  }
  if (broke !== undefined)
    recordRollback(
      app,
      input.name,
      { at: new Date().toISOString(), commit: broke.commit.slice(0, 12), why: broke.why, to: out[0]?.kind === "last-good" ? "last-good" : "parent" },
      broke.commit,
    );
  return [...out, fallback];
}

/**
 * Try each source until one starts. `attempt` starts a cell on a source and
 * says why not on failure. Every source that failed before the one that
 * worked is a rollback. `up` hears the one that worked.
 */
export async function startFirstThatWorks<T>(
  app: App,
  name: string,
  sources: readonly CodeSource[],
  attempt: (source: CodeSource) => Promise<{ child: T } | { why: string }>,
): Promise<{ child: T; source: CodeSource } | { why: string }> {
  let last = "no code to start";
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (source === undefined) break;
    let result: { child: T } | { why: string };
    try {
      result = await attempt(source);
    } catch (error) {
      // A cell that cannot even be made is a failed attempt like any other: the next source is tried.
      app.log.warn("child forge cell could not be made", { name, kind: source.kind, error: String(error) });
      result = { why: "its cell could not be made" };
    }
    if ("child" in result) {
      if (source.kind !== "parent" && source.commit !== undefined) recordGood(app, name, source.commit);
      return { child: result.child, source };
    }
    last = result.why;
    const next = sources[i + 1];
    if (next !== undefined && source.kind !== "parent")
      recordRollback(
        app,
        name,
        { at: new Date().toISOString(), commit: (source.commit ?? "").slice(0, 12), why: result.why, to: next.kind === "last-good" ? "last-good" : "parent" },
        source.kind === "own" ? source.commit : undefined,
      );
  }
  return { why: last };
}

/** Starts of one forge run one at a time, so two wakes never check out or prune the same directory together. */
const queues = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(app: App, name: string, run: () => Promise<T>): Promise<T> {
  const key = `${app.config.dataDir}\0${name}`;
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.catch(() => {}).then(run);
  const tail = mine.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return mine;
}
