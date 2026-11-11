/**
 * Every git subprocess in the forge goes through here. The environment is
 * deterministic — server-side git must never inherit operator config — and
 * every spawn carries a wall-clock timeout with a kill, because a hung git
 * process must never become a hung request.
 *
 * It also carries the one limit that keeps a fleet of agents from taking the
 * host down: a semaphore. A repo page is half a dozen git processes, so two
 * hundred agents browsing at once is a thousand forks, and a thousand forks
 * is not slow — it is a machine that stops answering. The queue is the
 * difference between "the forge got busy" and "the forge fell over".
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../kernel/result.ts";
import { memoryLimitBytes } from "../core/capacity.ts";
import { noteGit } from "../perf/git.ts";
import { gitRecord } from "../perf/live.ts";

/** Base env for all server-side git. Nothing from the host leaks in. */
export function gitEnv(extra?: Record<string, string>): Record<string, string> {
  const trust = trustedCaBundle();
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...(trust === undefined ? {} : { GIT_SSL_CAINFO: trust }),
    ...extra,
  };
}

/** Where a system keeps the certificates it trusts, by distribution. */
const SYSTEM_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/cert.pem",
  "/etc/pki/tls/certs/ca-bundle.crt",
];

const bundles = new Map<string, string | undefined>();

/**
 * What git trusts over https: the runtime's extra certificate authority —
 * `NODE_EXTRA_CA_CERTS`, the platform's private one inside a cluster — on
 * top of the system's bundle, in one file, because git trusts one file and
 * the two it needs are separate. Built once per authority; nothing when
 * there is no extra authority, or no system bundle to add it to.
 */
export function trustedCaBundle(
  extra = process.env["NODE_EXTRA_CA_CERTS"] ?? "",
): string | undefined {
  if (extra === "") return undefined;
  const known = bundles.get(extra);
  if (known !== undefined || bundles.has(extra)) return known;
  let built: string | undefined;
  const system = SYSTEM_CA_BUNDLES.find((path) => existsSync(path));
  if (system !== undefined && existsSync(extra)) {
    try {
      const path = join(
        tmpdir(),
        `forge-ca-${process.pid}-${bundles.size}.crt`,
      );
      writeFileSync(
        path,
        `${readFileSync(system, "utf8").trimEnd()}\n${readFileSync(extra, "utf8")}`,
        { mode: 0o644 },
      );
      // The file is this process's: it goes when the process does.
      process.on("exit", () => rmSync(path, { force: true }));
      built = path;
    } catch {
      built = undefined;
    }
  }
  bundles.set(extra, built);
  return built;
}

// ---- the spawn limit ----

/**
 * A counting semaphore with a FIFO queue. Twenty lines, no dependency, and
 * the only thing standing between an agent fleet and `fork: Resource
 * temporarily unavailable`.
 *
 * FIFO on purpose: LIFO would be marginally better for cache locality and
 * catastrophically worse for fairness, which is the entire point — the
 * request that has waited longest goes next, so a burst degrades everyone's
 * latency a little rather than starving somebody forever. The one
 * exception is asked for by name (`first`), and is FIFO among itself.
 */
export class Gate {
  private active = 0;
  private readonly waiting: { wake: () => void; first: boolean }[] = [];
  private peak = 0;

  constructor(private max: number) {}

  /** How many permits may be held at once. */
  get limit(): number {
    return this.max;
  }

  /**
   * Change the limit while permits are held (`core/capacity.ts`: an admin
   * lowers or raises a concurrency live). Raised, waiters go at once up to
   * the new limit; lowered, nobody holding a permit is touched — releases
   * stop handing permits on until the count is under it.
   */
  resize(limit: number): void {
    this.max = Math.max(1, Math.floor(limit));
    while (this.active < this.limit) {
      const next = this.waiting.shift();
      if (next === undefined) break;
      this.active++;
      next.wake();
    }
  }

  /**
   * Take a permit, waiting for one if none is free. `first` waits ahead of
   * everyone who is not — still FIFO among its own kind, so it can jump a
   * queue but never starve another `first` — which is how a production
   * deploy gets the next permit while previews are waiting.
   */
  async acquire(options: { first?: boolean } = {}): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // Wait for a permit to be *handed* to us. The releaser does not
      // decrement when it wakes somebody: the count stays taken and simply
      // changes owner. Decrementing first would open a window in which a
      // caller arriving synchronously slips in ahead of the queue and the
      // limit is briefly exceeded — a semaphore that is only usually one.
      const first = options.first === true;
      await new Promise<void>((wake) => {
        const behind = first ? this.waiting.findIndex((w) => !w.first) : -1;
        if (behind === -1) this.waiting.push({ wake, first });
        else this.waiting.splice(behind, 0, { wake, first });
      });
    }
    if (this.active > this.peak) this.peak = this.active;
    let released = false;
    return () => {
      // Idempotent: a caller that releases twice must not hand out a permit
      // it never held, which is how a semaphore quietly stops being one.
      if (released) return;
      released = true;
      // Over the limit (it was lowered), the permit is returned, not handed on.
      const next = this.active <= this.limit ? this.waiting.shift() : undefined;
      if (next !== undefined) next.wake();
      else this.active--;
    };
  }

  /** Run `work` holding one permit, released however it ends. */
  async run<T>(
    work: () => Promise<T>,
    options: { first?: boolean } = {},
  ): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await work();
    } finally {
      release();
    }
  }

  stats(): { active: number; waiting: number; limit: number; peak: number } {
    return {
      active: this.active,
      waiting: this.waiting.length,
      limit: this.limit,
      peak: this.peak,
    };
  }

  /** Test seam. */
  resetPeak(): void {
    this.peak = this.active;
  }
}

const limitFromEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/**
 * Short-lived plumbing: `rev-parse`, `cat-file`, `diff`, `commit-tree`. These
 * are milliseconds each, so a small limit costs almost nothing in latency and
 * buys a hard ceiling on process count.
 */
export const gitGate = new Gate(limitFromEnv("FORGE_GIT_CONCURRENCY", 8));

/**
 * Blob streams for the media route: a video seeks for minutes, so a stream
 * holds its permit until the last byte or the reader hangs up. A pool of its
 * own, so a page of videos never takes the plumbing permits every page needs.
 */
export const mediaGate = new Gate(limitFromEnv("FORGE_MEDIA_CONCURRENCY", 16));

/**
 * How many pack transfers a host of `bytes` memory runs at once by default:
 * one per 64 MiB, at least two, at most sixteen. A push is not one process
 * but three while it runs: `receive-pack`, the pre-receive hook (a whole Bun
 * runtime relaying to the forge) and the git it calls back into. Sixteen of
 * those on a 512 MiB cell, with the clients beside them, is past the cgroup's
 * limit: the kernel reclaims the binaries' pages, every process waits on the
 * disk, and the hook relay times out after two minutes with nothing wrong but
 * the count (gate (1) on the isolated runner). Every host with 1 GiB or more
 * keeps sixteen; `FORGE_GIT_TRANSFER_CONCURRENCY` still overrides it. A push
 * past the count waits for a permit before its hook starts, so the wait is
 * never charged to the relay's deadline.
 */
export function transfersForMemory(bytes: number): number {
  const n = Math.floor(bytes / (64 * 1024 * 1024));
  return Math.min(16, Math.max(2, Number.isFinite(n) ? n : 16));
}

/**
 * Pack transfers: `upload-pack` and `receive-pack`. A separate pool, and that
 * separation is load-bearing — a `receive-pack` holds its permit for the
 * whole push, and the pre-receive hook it runs comes back into the forge and
 * needs *plumbing* permits to check branch protection. One shared pool would
 * deadlock the moment pushes filled it.
 */
export const transferGate = new Gate(
  limitFromEnv("FORGE_GIT_TRANSFER_CONCURRENCY", transfersForMemory(memoryLimitBytes())),
);

export interface GitFailure {
  readonly code: number;
  readonly stderr: string;
  readonly args: readonly string[];
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  /** Kill the process after this long. @default 30_000 */
  timeoutMs?: number;
  /** Kill the process, and fail with code `OVER_CAP`, once stdout passes this many bytes. */
  maxBytes?: number;
  /** Kill the process when this aborts. */
  signal?: AbortSignal;
}

/** Run git to completion, capturing output as bytes. Non-zero exit is an Err. */
export const OVER_CAP = -2;

export async function runGitRaw(
  args: readonly string[],
  options: RunOptions = {},
): Promise<Result<Uint8Array, GitFailure>> {
  // Timed from before the gate: a wait for a permit is the queue #8158 names.
  const start = performance.now();
  return gitGate.run(async () => {
    const proc = Bun.spawn(["git", ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: gitEnv(options.env),
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const stop = () => proc.kill("SIGKILL");
    let over = false;
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([
        readAll(proc.stdout, options.maxBytes, () => {
          over = true;
          stop();
        }),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (over) return err({ code: OVER_CAP, stderr: "output over the cap", args });
      if (code !== 0) return err({ code, stderr: stderr.trim(), args });
      return ok(stdout);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      noteGit(gitRecord, args, start);
    }
  });
}

/** Run git to completion, capturing stdout as trimmed text. */
export async function runGit(
  args: readonly string[],
  options: RunOptions = {},
): Promise<Result<string, GitFailure>> {
  const result = await runGitRaw(args, options);
  if (!result.ok) return result;
  return ok(new TextDecoder().decode(result.value).replace(/\n$/, ""));
}

export interface GitCapture {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The timeout killed the process. */
  readonly timedOut?: boolean;
  /** `stopAfterLines` was reached: stdout holds that many lines and the process was killed for it. */
  readonly stopped?: boolean;
}

export interface CaptureOptions extends RunOptions {
  /**
   * Keep only the first this-many newline-ended lines of stdout and kill the
   * process once they are read. For a caller that wants the first few
   * answers of a command whose whole output can be megabytes (`git grep a`).
   */
  stopAfterLines?: number;
  /** Kill the process when this fires (reported as `timedOut`); one already fired never starts it. */
  signal?: AbortSignal;
}

/**
 * The first `max` lines of `stream`, read as they come; `stop` is called
 * once they are in, and nothing past them is kept. Without `max`, all of it.
 */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  max: number | undefined,
  stop: () => void,
): Promise<{ text: string; stopped: boolean }> {
  if (max === undefined) return { text: await new Response(stream).text(), stopped: false };
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let lines = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let cut = -1;
      for (let i = 0; i < value.length; i++) {
        if (value[i] === 10 && ++lines >= max) {
          cut = i + 1;
          break;
        }
      }
      if (cut < 0) {
        parts.push(decoder.decode(value, { stream: true }));
        continue;
      }
      parts.push(decoder.decode(value.subarray(0, cut)));
      stop();
      return { text: parts.join(""), stopped: true };
    }
    parts.push(decoder.decode());
    return { text: parts.join(""), stopped: false };
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Run git and capture stdout AND stderr regardless of exit code. Some
 * plumbing (merge-tree, diff --exit-code) uses a non-zero exit as *data*,
 * not failure, and puts the payload on stdout — this hands both back.
 */
export async function runGitCapture(
  args: readonly string[],
  options: CaptureOptions = {},
): Promise<GitCapture> {
  const start = performance.now();
  return gitGate.run(async () => {
    if (options.signal?.aborted === true) return { code: 1, stdout: "", stderr: "", timedOut: true };
    const proc = Bun.spawn(["git", ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: gitEnv(options.env),
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        proc.kill("SIGKILL");
      },
      options.timeoutMs ?? 30_000,
    );
    const abort = () => {
      timedOut = true;
      proc.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const [out, stderr, code] = await Promise.all([
        readLines(proc.stdout, options.stopAfterLines, () => proc.kill("SIGKILL")),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return {
        code,
        stdout: out.text,
        stderr,
        ...(timedOut && !out.stopped ? { timedOut } : {}),
        ...(out.stopped ? { stopped: true } : {}),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      noteGit(gitRecord, args, start);
    }
  });
}

/**
 * Copy every chunk out of the stream. Bun can hand back views over recycled
 * spawn-pipe buffers, so slices of the original chunks are not safe to hold.
 */
async function readAll(
  stream: ReadableStream<Uint8Array>,
  maxBytes?: number,
  onOver?: () => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk.slice());
    total += chunk.length;
    if (maxBytes !== undefined && total > maxBytes) {
      onOver?.();
      break;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
