/**
 * Git over SSH: the same thin pipe as `smart-http.ts`, minus the request
 * framing. An SSH client runs `git-upload-pack '/owner/repo.git'` on an exec
 * channel and then speaks the *stateful* protocol down that one channel —
 * there is no `--stateless-rpc` here, and no HTTP round-trip to bound it.
 *
 * This file knows nothing about users or repos. It parses the command a
 * client asked for and pipes bytes; the access decision belongs to the caller,
 * exactly as it does for smart HTTP.
 */

import { isSafeName } from "./guard.ts";
import { gitEnv } from "./env.ts";
import type { GitService } from "./smart-http.ts";

export type { GitService };

/** What a client's exec command asked for, once it has passed the guards. */
export interface GitCommand {
  readonly service: GitService;
  readonly owner: string;
  readonly name: string;
}

/**
 * Split an exec command the way a shell would, honouring the quoting OpenSSH
 * actually emits (`git-upload-pack '/owner/repo.git'`, and the backslash form
 * some clients use for odd characters). Returns null on unbalanced quotes
 * rather than guessing.
 */
export function splitCommand(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === null && /\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    started = true;
    if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
      word += command[++i]!;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    word += ch;
  }
  if (quote !== null) return null;
  if (started) words.push(word);
  return words;
}

/**
 * Recognise a git service command. Both spellings are accepted — OpenSSH's
 * `git-upload-pack <path>` and the `git upload-pack <path>` form some clients
 * and `GIT_SSH_COMMAND` wrappers produce. The path is normalised the way
 * every hosting provider does: a leading `/` or `~/` and a trailing `.git`
 * are decoration, and both halves must pass `isSafeName` before anything
 * touches the filesystem.
 */
export function parseGitCommand(command: string): GitCommand | null {
  const words = splitCommand(command);
  if (words === null || words.length === 0) return null;
  let service: string | undefined;
  let path: string | undefined;
  if (words[0] === "git" && words.length >= 3) {
    service = `git-${words[1]!}`;
    path = words[2];
  } else if (words.length >= 2) {
    service = words[0];
    path = words[1];
  }
  if (service !== "git-upload-pack" && service !== "git-receive-pack")
    return null;
  if (path === undefined) return null;

  let target = path.replace(/^~\//, "").replace(/^\/+/, "");
  if (target.endsWith(".git")) target = target.slice(0, -4);
  const parts = target.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!isSafeName(owner) || !isSafeName(name)) return null;
  return { service, owner, name };
}

/**
 * The duplex an SSH exec channel presents. Structurally satisfied by
 * `SshSession`, so this module never imports the SSH server — and a test can
 * drive it with an object literal.
 */
export interface GitChannel {
  write(data: Uint8Array | string): void;
  writeStderr(data: Uint8Array | string): void;
  onData(cb: (data: Uint8Array) => void): void;
  /** The peer half-closed: it has sent everything it is going to send. */
  onEof(cb: () => void): void;
  /** The channel is gone. Nothing can be delivered to the peer any more. */
  onClose(cb: () => void): void;
  exit(code: number): void;
  drain(): Promise<void>;
}

export interface GitServiceOptions {
  /** Extra env for the spawned git process (hook identity, GIT_PROTOCOL). */
  env?: Record<string, string>;
  /** Kill a wedged transfer after this long. @default 600_000 */
  timeoutMs?: number;
}

/**
 * Run one git service against `dir`, wired to the channel in both directions.
 * Output is written under backpressure: git's stdout can produce a pack far
 * faster than the peer's window drains it, and awaiting `drain()` between
 * chunks is what keeps a clone from buffering the whole pack in memory.
 */
export function runGitService(
  dir: string,
  service: GitService,
  channel: GitChannel,
  options: GitServiceOptions = {},
): Promise<number> {
  // "git-upload-pack" the service is "upload-pack" the subcommand.
  const proc = Bun.spawn(["git", service.slice(4), dir], {
    env: gitEnv(options.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(
    () => proc.kill("SIGKILL"),
    options.timeoutMs ?? 600_000,
  );

  channel.onData((chunk) => {
    try {
      proc.stdin.write(chunk);
      void proc.stdin.flush();
    } catch {
      // git exited under us; its exit code is the answer, not this write.
    }
  });
  // The peer's EOF means "I have sent everything", not "we are done": a
  // clone's whole pack arrives *after* the client half-closes. So this ends
  // git's stdin and nothing else — stop reading its stdout here and git dies
  // of SIGPIPE mid-transfer, which is exactly the bug this comment prevents.
  channel.onEof(() => {
    try {
      void proc.stdin.end();
    } catch {
      /* already gone */
    }
  });
  // A *close* is different: the peer is gone, so every byte git still has to
  // give has nowhere to go. Without this the child sits in `upload-pack`
  // writing into a dead channel until the ten-minute timeout reaps it — one
  // idle git per disconnected clone.
  channel.onClose(() => {
    clearTimeout(timer);
    proc.kill("SIGKILL");
  });

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    write: (data: Uint8Array) => void,
  ): Promise<void> => {
    for await (const chunk of stream) {
      // The chunk may be a view over a recycled spawn buffer, so copy before
      // it is queued behind the peer's window. On a dead channel `write` is a
      // no-op and `drain` resolves at once, so this drains and ends.
      write(chunk.slice());
      await channel.drain();
    }
  };

  return (async () => {
    const [, , code] = await Promise.all([
      pump(proc.stdout, (data) => channel.write(data)),
      pump(proc.stderr, (data) => channel.writeStderr(data)),
      proc.exited,
    ]);
    clearTimeout(timer);
    channel.exit(code);
    return code;
  })();
}
