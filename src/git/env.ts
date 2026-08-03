/**
 * Every git subprocess in the forge goes through here. The environment is
 * deterministic — server-side git must never inherit operator config — and
 * every spawn carries a wall-clock timeout with a kill, because a hung git
 * process must never become a hung request.
 */

import { err, ok, type Result } from "../kernel/result.ts";

/** Base env for all server-side git. Nothing from the host leaks in. */
export function gitEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
}

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
}

/** Run git to completion, capturing output as bytes. Non-zero exit is an Err. */
export async function runGitRaw(
  args: readonly string[],
  options: RunOptions = {},
): Promise<Result<Uint8Array, GitFailure>> {
  const proc = Bun.spawn(["git", ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: gitEnv(options.env),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      readAll(proc.stdout),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return err({ code, stderr: stderr.trim(), args });
    return ok(stdout);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Copy every chunk out of the stream. Bun can hand back views over recycled
 * spawn-pipe buffers, so slices of the original chunks are not safe to hold.
 */
async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk.slice());
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
