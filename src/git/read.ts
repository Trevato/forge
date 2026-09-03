/**
 * Read paths for the UI and API. Object access rides a long-lived
 * `git cat-file --batch` process per repo — one spawn amortized over
 * thousands of lookups. Everything here is read-only and safe to cache by
 * object id, because objects are immutable.
 */

import { defect } from "../kernel/error.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { gitEnv, runGit, runGitRaw, type GitFailure } from "./env.ts";

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
    }
  | { readonly kind: "text"; readonly body: Uint8Array; readonly size: number };

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

  const kind = await runGit(["cat-file", "-t", spec], { cwd: dir });
  if (!kind.ok || kind.value !== "blob") return { kind: "missing" };

  const sizeText = await runGit(["cat-file", "-s", spec], { cwd: dir });
  if (!sizeText.ok) return { kind: "missing" };
  const size = Number(sizeText.value);
  if (!Number.isSafeInteger(size)) return { kind: "missing" };
  if (size > maxBytes) return { kind: "too_large", size };

  const body = await runGitRaw(["cat-file", "blob", spec], { cwd: dir });
  if (!body.ok) return { kind: "missing" };
  // NUL in the first 8KB is git's own binary heuristic.
  if (body.value.subarray(0, 8000).includes(0))
    return { kind: "binary", body: body.value, size };
  return { kind: "text", body: body.value, size };
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
): Promise<Result<Ref[], GitFailure>> {
  const result = await runGit(
    [
      "for-each-ref",
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
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b",
    `--max-count=${options.limit ?? 50}`,
    `--skip=${options.skip ?? 0}`,
    rev,
    "--",
  ];
  if (options.path !== undefined) args.push(options.path);
  const result = await runGitRaw(args, { cwd: dir });
  if (!result.ok) return result;

  const text = new TextDecoder().decode(result.value);
  const commits: Commit[] = [];
  // -z terminates each record with NUL; fields inside are NUL-separated too,
  // so records are groups of 7 fields.
  const fields = text.split("\0");
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
  return ok(commits);
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
