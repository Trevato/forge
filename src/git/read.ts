/**
 * Read paths for the UI and API. Object access rides a long-lived
 * `git cat-file --batch` process per repo — one spawn amortized over
 * thousands of lookups. Everything here is read-only and safe to cache by
 * object id, because objects are immutable.
 */

import { defect } from "../kernel/error.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { gitEnv, mediaGate, runGit, runGitRaw, type GitFailure } from "./env.ts";
import { isSafeOid, isSafeRef } from "./guard.ts";

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export interface ObjectStat {
  readonly oid: string;
  readonly type: ObjectType;
  readonly size: number;
}

export interface GitObject extends ObjectStat {
  readonly body: Uint8Array;
}

/** A rev expression we are willing to hand to cat-file's stdin. */
function assertBatchSafe(rev: string): void {
  if (
    rev.length === 0 ||
    rev.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(rev) ||
    rev.startsWith("-")
  ) {
    defect("git.unsafe_rev", `unsafe rev expression: ${JSON.stringify(rev)}`);
  }
}

export class RepoReader {
  private batch: BatchProc;
  private check: BatchProc;

  constructor(readonly dir: string) {
    this.batch = new BatchProc(dir, "--batch");
    this.check = new BatchProc(dir, "--batch-check");
  }

  /** Full object content. `rev` may be an oid, ref, or `ref:path`. */
  async object(rev: string): Promise<Result<GitObject, "missing">> {
    assertBatchSafe(rev);
    return this.batch.request(rev, true);
  }

  /** Type and size only — no body read off the pipe. */
  async stat(rev: string): Promise<Result<ObjectStat, "missing">> {
    assertBatchSafe(rev);
    const result = await this.check.request(rev, false);
    return result.ok ? ok(result.value) : result;
  }

  close(): void {
    this.batch.close();
    this.check.close();
  }
}

// ---- the reader pool ----

/**
 * One `cat-file` pair per hot repository, kept alive between requests.
 *
 * A `RepoReader` is two long-lived git processes, and the whole reason it
 * exists is that spawning git per object is the difference between a tree
 * page costing a millisecond and costing fifty. But a reader per repo held
 * forever is two file descriptors and ~4 MB of RSS per repo, and a forge
 * with two thousand repos would hold four thousand processes open — so the
 * pool is bounded in both directions that can hurt: idle readers are evicted
 * on a timer, and the least recently used is closed when the cap is reached.
 *
 * Safe to reuse across pushes: `cat-file` re-reads the object store when a
 * lookup misses, so a reader opened before a push still finds what the push
 * wrote. Refs are resolved per lookup, not cached.
 */
const READER_IDLE_MS = 60_000;
const MAX_READERS = 64;

interface Pooled {
  readonly reader: RepoReader;
  usedAt: number;
}

const pool = new Map<string, Pooled>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function sweepReaders(now = Date.now()): void {
  for (const [dir, entry] of pool) {
    if (now - entry.usedAt >= READER_IDLE_MS) {
      entry.reader.close();
      pool.delete(dir);
    }
  }
  if (pool.size === 0 && sweeper !== undefined) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

/**
 * The reader for `dir`, opened on first use. Callers never close it — the
 * pool owns its lifetime, which is what makes "just ask for a reader" the
 * cheap thing to do rather than a resource decision at every call site.
 */
export function readerFor(dir: string): RepoReader {
  const existing = pool.get(dir);
  if (existing !== undefined) {
    existing.usedAt = Date.now();
    // Re-insert so Map iteration order stays LRU order.
    pool.delete(dir);
    pool.set(dir, existing);
    return existing.reader;
  }
  if (pool.size >= MAX_READERS) {
    const oldest = pool.keys().next();
    if (!oldest.done) {
      pool.get(oldest.value)?.reader.close();
      pool.delete(oldest.value);
    }
  }
  const reader = new RepoReader(dir);
  pool.set(dir, { reader, usedAt: Date.now() });
  if (sweeper === undefined) {
    sweeper = setInterval(() => sweepReaders(), READER_IDLE_MS);
    // The pool must never be the reason a process refuses to exit.
    sweeper.unref?.();
  }
  return reader;
}

/**
 * Drop the reader for one repo. Called when a repo is deleted: a `cat-file`
 * holding a deleted directory open is how a forge leaks disk on a platform
 * that keeps unlinked files alive for their last descriptor.
 */
export function closeReader(dir: string): void {
  const entry = pool.get(dir);
  if (entry === undefined) return;
  entry.reader.close();
  pool.delete(dir);
}

/**
 * Drop every reader under one repos root. The pool is process-global (it is
 * keyed by directory, and directories are globally unique), but a *forge* is
 * one data directory — so closing a forge has to release the processes that
 * belong to it, or a test suite that boots fifty forges leaves a hundred
 * `cat-file`s idling on directories it has already deleted.
 */
export function closeReadersUnder(prefix: string): number {
  let closed = 0;
  for (const [dir, entry] of pool) {
    if (dir === prefix || dir.startsWith(`${prefix}/`)) {
      entry.reader.close();
      pool.delete(dir);
      closed++;
    }
  }
  return closed;
}

/** Shut the pool down — process exit, and the seam every test uses. */
export function closeAllReaders(): void {
  for (const entry of pool.values()) entry.reader.close();
  pool.clear();
  if (sweeper !== undefined) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

/** For the pool's own tests. */
export const readerPoolSize = (): number => pool.size;
export const sweepReaderPool = (now?: number): void => sweepReaders(now);

/** One cat-file process with a buffered stdout reader and serialized access. */
class BatchProc {
  private proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  private reader: AsyncIterator<Uint8Array> | undefined;
  private buffer: Uint8Array = new Uint8Array(0);
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly mode: "--batch" | "--batch-check",
  ) {}

  request(rev: string, withBody: true): Promise<Result<GitObject, "missing">>;
  request(rev: string, withBody: false): Promise<Result<ObjectStat, "missing">>;
  request(
    rev: string,
    withBody: boolean,
  ): Promise<Result<GitObject | ObjectStat, "missing">> {
    const run = this.queue.then(() => this.exchange(rev, withBody));
    // The queue must survive a failed exchange; errors belong to the caller.
    this.queue = run.catch(() => {});
    return run;
  }

  private ensureProc() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed)
      return this.proc;
    this.proc = Bun.spawn(["git", "cat-file", this.mode], {
      cwd: this.dir,
      env: gitEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.reader = this.proc.stdout[Symbol.asyncIterator]();
    this.buffer = new Uint8Array(0);
    return this.proc;
  }

  private async exchange(
    rev: string,
    withBody: boolean,
  ): Promise<Result<GitObject | ObjectStat, "missing">> {
    const proc = this.ensureProc();
    proc.stdin.write(`${rev}\n`);
    await proc.stdin.flush();

    const header = await this.readLine();
    const parts = header.split(" ");
    // "<rev> missing" | "<rev> ambiguous" — anything but a clean hit is a miss.
    if (parts.length < 3) return err("missing");

    const [oid, type, sizeText] = parts as [string, string, string];
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) return err("missing");
    const stat: ObjectStat = { oid, type: type as ObjectType, size };

    if (!withBody) return ok(stat);
    const body = await this.readExact(size);
    await this.readExact(1); // trailing LF after the body
    return ok({ ...stat, body });
  }

  private async fill(): Promise<void> {
    if (!this.reader)
      defect("git.reader_gone", "cat-file stdout reader missing");
    const { done, value } = await this.reader.next();
    if (done === true || value === undefined) {
      // Process died mid-read; drop it so the next request respawns.
      this.proc = undefined;
      defect(
        "git.catfile_died",
        `cat-file ${this.mode} exited mid-response in ${this.dir}`,
      );
    }
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer);
    merged.set(value, this.buffer.length); // copy: spawn pipes recycle buffers
    this.buffer = merged;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl !== -1) {
        const line = new TextDecoder().decode(this.buffer.subarray(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        return line;
      }
      await this.fill();
    }
  }

  private async readExact(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) await this.fill();
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  close(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}

// ---- per-call reads (spawn each time; correctness over reuse) ----

export type BlobForRender =
  | { readonly kind: "missing" }
  | { readonly kind: "too_large"; readonly size: number }
  | {
      readonly kind: "binary";
      readonly body: Uint8Array;
      readonly size: number;
      readonly oid: string;
    }
  | {
      readonly kind: "text";
      readonly body: Uint8Array;
      readonly size: number;
      readonly oid: string;
    };

/**
 * Read a blob for rendering, size-bounded up front. The object is *stat*ed
 * with `cat-file -s` before a single byte is read, so a giant file costs a
 * stat and a verdict — never the memory to hold it. This is the guard that
 * keeps an anonymous request for a 2GB blob from touching 2GB of RSS.
 */
export async function blobForRender(
  dir: string,
  rev: string,
  path: string,
  maxBytes: number,
): Promise<BlobForRender> {
  const spec = `${rev}:${path}`;
  assertBatchSafe(spec);

  // The pooled reader answers both the stat and the body without a fork.
  // Two `cat-file` invocations used to become three processes per blob, and
  // a file tree is one of those per file — the single largest source of
  // spawn pressure the forge had.
  const pooled = await viaReader(dir, spec, maxBytes);
  if (pooled !== undefined) return pooled;

  // The reader died (a repo removed under us, a git that refused to start).
  // Correctness does not depend on the pool, so fall back to plain spawns.
  const kind = await runGit(["cat-file", "-t", spec], { cwd: dir });
  if (!kind.ok || kind.value !== "blob") return { kind: "missing" };

  const sizeText = await runGit(["cat-file", "-s", spec], { cwd: dir });
  if (!sizeText.ok) return { kind: "missing" };
  const size = Number(sizeText.value);
  if (!Number.isSafeInteger(size)) return { kind: "missing" };
  if (size > maxBytes) return { kind: "too_large", size };

  const named = await runGit(["rev-parse", "--verify", spec], { cwd: dir });
  if (!named.ok) return { kind: "missing" };
  const body = await runGitRaw(["cat-file", "blob", spec], { cwd: dir });
  if (!body.ok) return { kind: "missing" };
  return classify(body.value, size, named.value.trim());
}

/**
 * `undefined` means "the pool could not answer" — never "the blob is not
 * there". A miss the reader is sure about comes back as a real verdict, so
 * the fallback below runs only when the reader itself failed.
 */
async function viaReader(
  dir: string,
  spec: string,
  maxBytes: number,
): Promise<BlobForRender | undefined> {
  const reader = readerFor(dir);
  try {
    const stat = await reader.stat(spec);
    if (!stat.ok) return { kind: "missing" };
    if (stat.value.type !== "blob") return { kind: "missing" };
    const size = stat.value.size;
    if (!Number.isSafeInteger(size)) return { kind: "missing" };
    // The guard that matters: a 2 GB blob costs a stat and a verdict, and
    // not one byte off the pipe.
    if (size > maxBytes) return { kind: "too_large", size };
    const object = await reader.object(spec);
    if (!object.ok) return { kind: "missing" };
    return classify(object.value.body, size, object.value.oid);
  } catch {
    closeReader(dir);
    return undefined;
  }
}

/**
 * A blob's first `bytes` bytes, and never one more off the pipe: `cat-file`
 * is stopped once they are in, so a 4 GB file costs what its head does. For
 * a page that must say what a file too large to read is.
 */
export async function blobHead(
  dir: string,
  rev: string,
  path: string,
  bytes: number,
): Promise<Uint8Array | undefined> {
  const spec = `${rev}:${path}`;
  assertBatchSafe(spec);
  const proc = Bun.spawn(["git", "cat-file", "blob", spec], {
    cwd: dir,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  const head = new Uint8Array(bytes);
  let filled = 0;
  try {
    while (filled < bytes) {
      const next = await reader.read();
      if (next.done || next.value === undefined) break;
      const take = Math.min(next.value.length, bytes - filled);
      head.set(next.value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    proc.kill("SIGKILL");
  }
  if (filled === 0 && (await proc.exited) !== 0) return undefined;
  return head.subarray(0, filled);
}

function classify(body: Uint8Array, size: number, oid: string): BlobForRender {
  // NUL in the first 8KB is git's own binary heuristic.
  if (body.subarray(0, 8000).includes(0))
    return { kind: "binary", body, size, oid };
  return { kind: "text", body, size, oid };
}

export interface Ref {
  readonly name: string;
  readonly oid: string;
  /** For annotated tags, the commit the tag points at. */
  readonly peeled?: string;
}

export async function listRefs(
  dir: string,
  prefix = "refs/",
  newestFirst = false,
): Promise<Result<Ref[], GitFailure>> {
  const result = await runGit(
    [
      "for-each-ref",
      ...(newestFirst ? ["--sort=-refname", "--sort=-creatordate"] : []),
      "--format=%(refname)%00%(objectname)%00%(*objectname)",
      "--",
      prefix,
    ],
    { cwd: dir },
  );
  if (!result.ok) return result;
  if (result.value === "") return ok([]);
  const refs: Ref[] = [];
  for (const line of result.value.split("\n")) {
    const [name, oid, peeled] = line.split("\0");
    if (!name || !oid) continue;
    refs.push(peeled ? { name, oid, peeled } : { name, oid });
  }
  return ok(refs);
}

/** The branch HEAD points at, e.g. "main" — even in an empty repo. */
export async function headBranch(
  dir: string,
): Promise<Result<string, GitFailure>> {
  const result = await runGit(["symbolic-ref", "--short", "HEAD"], {
    cwd: dir,
  });
  return result;
}

export interface TreeEntry {
  readonly mode: string;
  readonly type: ObjectType;
  readonly oid: string;
  /** -1 for trees. */
  readonly size: number;
  readonly name: string;
}

/** List one level of a tree at `rev` and `path` ("" for the root). */
export async function listTree(
  dir: string,
  rev: string,
  path: string,
): Promise<Result<TreeEntry[], GitFailure>> {
  assertBatchSafe(`${rev}:${path}`);
  const result = await runGitRaw(["ls-tree", "-z", "-l", `${rev}:${path}`], {
    cwd: dir,
  });
  if (!result.ok) return result;
  const text = new TextDecoder().decode(result.value);
  const entries: TreeEntry[] = [];
  for (const record of text.split("\0")) {
    if (record === "") continue;
    // "<mode> <type> <oid> <size>\t<name>"
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/ +/);
    const [mode, type, oid, sizeText] = meta as [
      string,
      string,
      string,
      string,
    ];
    entries.push({
      mode,
      type: type as ObjectType,
      oid,
      size: sizeText === "-" ? -1 : Number(sizeText),
      name: record.slice(tab + 1),
    });
  }
  // Directories first, then files, both alphabetical — the one true order.
  entries.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "tree"
        ? -1
        : 1,
  );
  return ok(entries);
}

export interface Commit {
  readonly oid: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly email: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
}

export interface LogOptions {
  /** @default 50 */
  limit?: number;
  /** @default 0 */
  skip?: number;
  /** Restrict to commits touching this tree path. */
  path?: string;
  /** Only commits whose message matches this extended regular expression. */
  grep?: string;
}

/** When `oid` was committed, as an ISO time; undefined when git cannot say. */
export async function committedAt(dir: string, oid: string): Promise<string | undefined> {
  assertBatchSafe(oid);
  const result = await runGitRaw(["show", "-s", "--format=%cI", oid, "--"], { cwd: dir });
  if (!result.ok) return undefined;
  const when = new Date(new TextDecoder().decode(result.value).trim());
  return Number.isNaN(when.getTime()) ? undefined : when.toISOString();
}

/** The `git log -z` format `parseLogRecords` reads: seven NUL-separated fields. */
export const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b";

/** Records of `git log -z --format=LOG_FORMAT`: groups of 7 NUL-separated fields. */
export function parseLogRecords(bytes: Uint8Array): Commit[] {
  const commits: Commit[] = [];
  const fields = new TextDecoder().decode(bytes).split("\0");
  for (let i = 0; i + 6 < fields.length; i += 7) {
    commits.push({
      oid: fields[i]!,
      parents: fields[i + 1]! === "" ? [] : fields[i + 1]!.split(" "),
      author: fields[i + 2]!,
      email: fields[i + 3]!,
      date: fields[i + 4]!,
      subject: fields[i + 5]!,
      body: fields[i + 6]!.replace(/\n$/, ""),
    });
  }
  return commits;
}

export async function commitLog(
  dir: string,
  rev: string,
  options: LogOptions = {},
): Promise<Result<Commit[], GitFailure>> {
  assertBatchSafe(rev);
  const args = [
    "log",
    "-z",
    `--format=${LOG_FORMAT}`,
    `--max-count=${options.limit ?? 50}`,
    `--skip=${options.skip ?? 0}`,
    ...(options.grep === undefined ? [] : ["--extended-regexp", `--grep=${options.grep}`]),
    rev,
    "--",
  ];
  if (options.path !== undefined) args.push(options.path);
  const result = await runGitRaw(args, { cwd: dir });
  if (!result.ok) return result;

  return ok(parseLogRecords(result.value));
}

export interface PathListing {
  readonly paths: string[];
  /** True when the cap cut the listing short. */
  readonly truncated: boolean;
}

/**
 * Every blob path under `rev`, for a fuzzy file finder. One `ls-tree -r`;
 * NUL-separated so a newline in a path cannot split a record. Capped, because
 * a finder over a 500k-file monorepo needs a different tool.
 */
export async function listPaths(
  dir: string,
  rev: string,
  cap = 50_000,
): Promise<Result<PathListing, GitFailure>> {
  assertBatchSafe(rev);
  const result = await runGitRaw(["ls-tree", "-r", "-z", "--name-only", rev], {
    cwd: dir,
    timeoutMs: 20_000,
  });
  if (!result.ok) return result;
  const text = new TextDecoder().decode(result.value);
  const all = text.split("\0");
  if (all.at(-1) === "") all.pop();
  return ok({ paths: all.slice(0, cap), truncated: all.length > cap });
}

/**
 * The commit a ref names, read from the ref files themselves: no process.
 * A loose ref wins over `packed-refs`, as in git. Anything this does not
 * fully understand (a symbolic ref, a missing file, an odd line) answers
 * undefined and the caller asks git.
 */
export async function refTip(dir: string, ref: string): Promise<string | undefined> {
  if (!isSafeRef(ref) || !ref.startsWith("refs/") || ref.includes("..")) return undefined;
  const oid = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  try {
    const loose = (await Bun.file(`${dir}/${ref}`).text()).trim();
    return oid.test(loose) ? loose : undefined;
  } catch {
    // not loose: it may be packed
  }
  try {
    const packed = await Bun.file(`${dir}/packed-refs`).text();
    for (const line of packed.split("\n")) {
      if (line.endsWith(` ${ref}`) && oid.test(line.slice(0, line.length - ref.length - 1)))
        return line.slice(0, line.length - ref.length - 1);
    }
  } catch {
    // no packed-refs
  }
  return undefined;
}

/** How many requests may wait for a media permit before the next is turned away. */
export const MEDIA_QUEUE_MAX = 32;
/** A stream nobody has pulled from for this long is ended and its permit returned. */
export const MEDIA_IDLE_MS = 30_000;

/**
 * Bytes `start`..`end` (inclusive) of the blob `oid`, streamed straight off
 * `git cat-file` and never held whole: a 2 GB video costs a pipe, not 2 GB
 * of memory. Git cannot seek inside a blob, so the bytes before `start` are
 * read and dropped; past `end` the process is killed.
 *
 * The permit is taken before the stream exists, so there is no stream to
 * cancel while it is waiting; a reader whose `signal` aborts in the queue
 * gets `"gone"` and the permit goes back unspent. With `MEDIA_QUEUE_MAX`
 * already waiting, the answer is `"busy"` (a 503) rather than one more
 * waiter. Once open, the stream gives its permit back when it ends, when its
 * reader hangs up or its signal aborts, or when nothing has pulled from it
 * for `idleMs`, which keeps a reader that never reads from holding a permit
 * for good.
 */
export async function blobStream(
  dir: string,
  oid: string,
  start: number,
  end: number,
  limits: { idleMs?: number; queueMax?: number; signal?: AbortSignal } = {},
): Promise<ReadableStream<Uint8Array> | "busy" | "gone"> {
  if (!isSafeOid(oid)) defect("git.unsafe_oid", `unsafe oid: ${JSON.stringify(oid)}`);
  const free = mediaGate.stats();
  if (free.active >= free.limit && free.waiting >= (limits.queueMax ?? MEDIA_QUEUE_MAX))
    return "busy";
  const release = await mediaGate.acquire();
  // The reader left while it waited: the permit goes straight back, unspent.
  if (limits.signal?.aborted) {
    release();
    return "gone";
  }
  const proc = Bun.spawn(["git", "cat-file", "blob", oid], {
    cwd: dir,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const source = proc.stdout.getReader();
  const idleMs = limits.idleMs ?? MEDIA_IDLE_MS;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let offset = 0;
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(idle);
    limits.signal?.removeEventListener("abort", finish);
    proc.kill("SIGKILL");
    release();
  };
  limits.signal?.addEventListener("abort", finish, { once: true });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Armed from the first moment, so a response nobody ever reads ends too.
      idle = setTimeout(() => {
        finish();
        controller.error(new Error("media stream idle"));
      }, idleMs);
    },
    async pull(controller) {
      idle?.refresh();
      while (true) {
        const next = await source.read();
        const chunk = next.value;
        if (next.done || chunk === undefined) break;
        const from = offset;
        offset += chunk.length;
        if (offset <= start) continue;
        // A copy, not a view: Bun may recycle the pipe's buffer.
        controller.enqueue(
          chunk.slice(Math.max(0, start - from), Math.min(chunk.length, end + 1 - from)),
        );
        if (offset > end) break;
        return;
      }
      if (ended) return;
      finish();
      controller.close();
    },
    cancel() {
      finish();
    },
  });
}
