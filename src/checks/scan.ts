/**
 * Code scanning passes (#9593). On every push: the files each pushed branch
 * or tag changed get the secret scan, and its package.json files the
 * advisory check. Nightly: the default branch's whole tree gets both, and
 * static analysis. Read from the git store with `cat-file --batch`; no
 * network, no model, nothing run from the repository. What is found is
 * recorded by fingerprint (`scan_store.ts`), never by its text.
 */

import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import { runGit, runGitRaw } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { advisoryFindings, type Finding, secretFindings, staticFindings } from "./scan_rules.ts";
import { type FindingRow, noteScanRun, recordFindings } from "./scan_store.ts";

/** A pass reads at most this many files, each at most this big: a scan is bounded work. */
export const MAX_FILES = 5_000;
export const MAX_BYTES = 512 * 1024;

const ZERO = /^0+$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** What a read left out: past MAX_FILES, over MAX_BYTES, or a name `cat-file --batch` cannot ask for. */
interface Read {
  readonly texts: Map<string, string>;
  skipped: number;
}

/**
 * A name holding a newline would split its `cat-file --batch` request in two
 * and shift every later reply onto the wrong file: never asked for, counted
 * as skipped instead.
 */
const askable = (path: string): boolean => !path.includes("\n") && !path.includes("\r");

/**
 * `oid:path → text` for each named blob, skipping the large and the binary:
 * one `cat-file` for them all. Null when git could not be read at all, so a
 * caller that must not pass on silence (the hold) can tell.
 */
async function readFiles(dir: string, wanted: readonly { readonly oid: string; readonly path: string }[]): Promise<Read | null> {
  const out: Read = { texts: new Map(), skipped: 0 };
  const asked = wanted.filter((w) => askable(w.path));
  out.skipped = wanted.length - asked.length;
  if (asked.length > MAX_FILES) {
    out.skipped += asked.length - MAX_FILES;
    asked.length = MAX_FILES;
  }
  if (asked.length === 0) return out;
  const raw = await runGitRaw(["cat-file", "--batch"], { cwd: dir, stdin: asked.map((w) => `${w.oid}:${w.path}\n`).join(""), timeoutMs: 60_000 });
  if (!raw.ok) return null;
  const bytes = raw.value;
  const decoder = new TextDecoder();
  let at = 0;
  for (const w of asked) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0) break;
    const header = decoder.decode(bytes.subarray(at, nl)).split(" ");
    at = nl + 1;
    if (header[1] !== "blob") continue; // "missing", or a submodule's commit
    const size = Number(header[2]);
    const body = bytes.subarray(at, at + size);
    at += size + 1;
    if (size <= MAX_BYTES) out.texts.set(`${w.oid}:${w.path}`, decoder.decode(body));
    else out.skipped++;
  }
  return out;
}

async function listTree(dir: string, oid: string): Promise<string[]> {
  const r = await runGit(["ls-tree", "-r", "-z", "--name-only", oid], { cwd: dir });
  return r.ok ? r.value.split("\0").filter((p) => p !== "") : [];
}

/**
 * The files each `base → oid` pair changed, in one `diff-tree --stdin`: with
 * `--always` every pair prints its new commit, then its paths, so the
 * output splits back into pairs in order.
 */
async function listChangedMany(dir: string, pairs: readonly { readonly base: string; readonly oid: string }[]): Promise<string[][]> {
  const out: string[][] = pairs.map(() => []);
  if (pairs.length === 0) return out;
  const r = await runGit(["diff-tree", "--stdin", "--always", "-r", "-z", "--name-only", "--diff-filter=AMR"], {
    cwd: dir,
    stdin: pairs.map((p) => `${p.oid} ${p.base}\n`).join(""), // `commit parent`: diffs base → oid
    timeoutMs: 60_000,
  });
  if (!r.ok) return out;
  let k = -1;
  for (const token of r.value.split("\0")) {
    if (token === "") continue;
    if (k + 1 < pairs.length && token === pairs[k + 1]!.oid) {
      k++;
      continue;
    }
    if (k >= 0) out[k]!.push(token);
  }
  return out;
}

function filesOf(read: Read | null, oid: string, paths: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const p of paths) {
    const text = read?.texts.get(`${oid}:${p}`);
    if (text !== undefined) files.set(p, text);
  }
  return files;
}

export function findingsIn(files: ReadonlyMap<string, string>, withStatic: boolean): Finding[] {
  const out: Finding[] = [];
  for (const [path, text] of files) {
    out.push(...secretFindings(path, text), ...advisoryFindings(path, text));
    if (withStatic) out.push(...staticFindings(path, text));
  }
  return out;
}

/**
 * The push pass: returns how many findings were new. Never throws for a ref
 * it cannot read. Bounded work however many refs a push names: one
 * `diff-tree` and one `cat-file` for them all, at most MAX_FILES files. A new
 * branch is compared with the default branch's tip; only a push with no
 * default branch yet lists whole trees.
 */
export async function scanPush(
  app: App,
  repo: Repo,
  updates: readonly { readonly ref: string; readonly oldOid: string; readonly newOid: string }[],
): Promise<number> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const live = updates.filter((u) => (u.ref.startsWith("refs/heads/") || u.ref.startsWith("refs/tags/")) && OID.test(u.newOid) && !ZERO.test(u.newOid));
  if (live.length === 0) return 0;
  let tip = live.find((u) => u.ref === `refs/heads/${repo.defaultBranch}`)?.newOid;
  if (tip === undefined && live.some((u) => ZERO.test(u.oldOid))) {
    const r = await runGit(["rev-parse", "--verify", "-q", `refs/heads/${repo.defaultBranch}^{commit}`], { cwd: dir });
    if (r.ok && OID.test(r.value)) tip = r.value;
  }
  const paths: string[][] = live.map(() => []);
  const pairs: { base: string; oid: string; at: number }[] = [];
  for (const [i, u] of live.entries()) {
    const base = ZERO.test(u.oldOid) ? tip : u.oldOid;
    if (base === undefined) paths[i] = await listTree(dir, u.newOid);
    else if (base !== u.newOid) pairs.push({ base, oid: u.newOid, at: i });
  }
  const changed = await listChangedMany(dir, pairs);
  for (const [j, p] of pairs.entries()) paths[p.at] = changed[j]!;
  const read = await readFiles(dir, live.flatMap((u, i) => paths[i]!.map((path) => ({ oid: u.newOid, path }))));
  let fresh = 0;
  for (const [i, u] of live.entries()) {
    fresh += recordFindings(app.db, repo.id, u.newOid, findingsIn(filesOf(read, u.newOid, paths[i]!), false));
  }
  const total = live.reduce((n, _, i) => n + paths[i]!.length, 0);
  noteScanRun(app.db, repo.id, "push", live.at(-1)!.newOid, read === null ? total : read.skipped);
  return fresh;
}

/** The nightly pass over the default branch's whole tree, static analysis included. */
export async function scanNightly(app: App, repo: Repo): Promise<number> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await runGit(["rev-parse", "--verify", "-q", `refs/heads/${repo.defaultBranch}^{commit}`], { cwd: dir });
  if (!tip.ok || !OID.test(tip.value)) {
    noteScanRun(app.db, repo.id, "nightly", "");
    return 0;
  }
  const paths = await listTree(dir, tip.value);
  const read = await readFiles(dir, paths.map((path) => ({ oid: tip.value, path })));
  const fresh = recordFindings(app.db, repo.id, tip.value, findingsIn(filesOf(read, tip.value, paths), true));
  noteScanRun(app.db, repo.id, "nightly", tip.value, read === null ? paths.length : read.skipped);
  return fresh;
}

/**
 * Which of `findings` are still in the tree at `oid`: each one's file is read
 * there and scanned again, and a finding stands only where its fingerprint
 * (rule, path and the hashed match) comes back. So a secret on a branch that
 * never reached `oid`, or one since removed, is not there. Null when git
 * could not be read: the hold then believes every finding.
 */
export async function presentAt(app: App, repo: Repo, oid: string, findings: readonly FindingRow[]): Promise<FindingRow[] | null> {
  if (findings.length === 0) return [];
  if (!OID.test(oid)) return null;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const paths = [...new Set(findings.map((f) => f.path))];
  const read = await readFiles(dir, paths.map((path) => ({ oid, path })));
  if (read === null || read.skipped > 0) return null;
  const there = new Set(findingsIn(filesOf(read, oid, paths), true).map((f) => f.fingerprint));
  return findings.filter((f) => there.has(f.fingerprint));
}

/** Each app's push scans, chained per repository: one after another, and awaitable. */
const queues = new WeakMap<App, Map<string, Promise<unknown>>>();

/**
 * Queues the push pass behind the repository's earlier ones and returns it.
 * The hook does not wait for it; `scansSettled` does.
 */
export function queueScanPush(
  app: App,
  repo: Repo,
  updates: readonly { readonly ref: string; readonly oldOid: string; readonly newOid: string }[],
): Promise<number> {
  let byRepo = queues.get(app);
  if (byRepo === undefined) queues.set(app, (byRepo = new Map()));
  const prior = byRepo.get(repo.id) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(() => scanPush(app, repo, updates));
  const tail = next.catch(() => undefined);
  byRepo.set(repo.id, tail);
  void tail.then(() => {
    if (byRepo.get(repo.id) === tail) byRepo.delete(repo.id);
  });
  return next;
}

/** Resolves once every push scan queued for the repository so far has finished. */
export async function scansSettled(app: App, repoId: string): Promise<void> {
  for (let q = queues.get(app)?.get(repoId); q !== undefined; q = queues.get(app)?.get(repoId)) {
    await q;
    if (queues.get(app)?.get(repoId) === q) return;
  }
}
