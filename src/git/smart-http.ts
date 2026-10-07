/**
 * Git smart HTTP, protocol v2 capable. The server side is deliberately a
 * thin, careful pipe: `git upload-pack | receive-pack --stateless-rpc` does
 * one read/write cycle per request, which maps 1:1 onto HTTP. We plumb
 * bytes, forward the protocol version, and never interpret the pack stream.
 */

import { holdForCaller } from "../http/caller.ts";
import { gunzipSync } from "node:zlib";
import {
  closeNow,
  counted,
  FETCH_MAX,
  GZIP_MAX,
  PUSH_MAX,
  readBounded,
} from "../http/limits.ts";
import { gitEnv, transferGate } from "./env.ts";

export type GitService = "git-upload-pack" | "git-receive-pack";

export function isGitService(value: string | null): value is GitService {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

/** pkt-line: 4 hex digits of (payload + 4), then the payload. */
function pktLine(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

const FLUSH = "0000";

export interface SmartHttpOptions {
  /** Extra env for the spawned git process (pusher identity for hooks, etc.). */
  env?: Record<string, string>;
  /** Kill a wedged transfer after this long. @default 600_000 */
  timeoutMs?: number;
}

/**
 * GET /:owner/:name.git/info/refs?service=… — the ref advertisement.
 * The `# service=` preamble is required for smart clients on protocol v0/v1
 * and ignored-by-spec on v2, so it is always sent.
 */
export async function advertiseRefs(
  repoDir: string,
  service: GitService,
  request: Request,
  options: SmartHttpOptions = {},
): Promise<Response> {
  const proc = await spawnService(repoDir, service, request, options, [
    "--advertise-refs",
  ]);

  const preamble = new TextEncoder().encode(
    pktLine(`# service=${service}\n`) + FLUSH,
  );
  const body = prepend(preamble, proc.stdout);

  return new Response(body, {
    headers: {
      "content-type": `application/x-${service}-advertisement`,
      "cache-control": "no-cache",
    },
  });
}

/**
 * POST /:owner/:name.git/git-{upload,receive}-pack — the transfer itself.
 * Request body streams to git's stdin (gunzipped if the client compressed
 * it); git's stdout streams back as the response.
 */
export async function serviceRpc(
  repoDir: string,
  service: GitService,
  request: Request,
  options: SmartHttpOptions = {},
): Promise<Response> {
  const proc = await spawnService(repoDir, service, request, options, []);
  feedStdin(proc, service, request).catch(() => proc.kill("SIGKILL"));

  return new Response(proc.stdout, {
    headers: {
      "content-type": `application/x-${service}-result`,
      "cache-control": "no-cache",
    },
  });
}

/**
 * Spawn one pack service, holding a transfer permit for its whole life.
 *
 * This is where a fleet would otherwise take the host down: a pack transfer
 * is not milliseconds, it is seconds to minutes of CPU and memory, and two
 * hundred agents cloning at once is two hundred of them at once. The permit
 * is released when the process exits, not when this returns — the response
 * is a stream over that process, so returning is the *middle* of the work.
 *
 * The pool is separate from the plumbing one on purpose: a receive-pack
 * holds its permit across the pre-receive hook, and that hook calls back
 * into the forge for a branch-protection check that needs plumbing permits
 * of its own. One shared pool would deadlock the first time pushes filled it.
 */
async function spawnService(
  repoDir: string,
  service: GitService,
  request: Request,
  options: SmartHttpOptions,
  extraArgs: readonly string[],
) {
  const release = await transferGate.acquire();
  // "git-upload-pack" the service is "upload-pack" the subcommand.
  const subcommand = service.slice(4);

  const env: Record<string, string> = { ...options.env };
  // Forward the client's protocol request, but only within git's own
  // grammar (colon-separated key[=value] tokens) and bounded — never an
  // arbitrary client string crossing into a subprocess environment.
  // Anything else silently falls back to v0.
  const protocol = request.headers.get("git-protocol");
  if (protocol !== null && /^[A-Za-z0-9=:._-]{1,200}$/.test(protocol)) {
    env.GIT_PROTOCOL = protocol;
  }

  const spawn = () =>
    Bun.spawn(["git", subcommand, "--stateless-rpc", ...extraArgs, repoDir], {
      env: gitEnv(env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (error) {
    // A spawn that never happened still holds a permit. Sixteen of these and
    // no transfer would ever start again — the permit has to go back on
    // every path out of here, not just the one where a process exists.
    release();
    throw error;
  }

  const timer = setTimeout(
    () => proc.kill("SIGKILL"),
    options.timeoutMs ?? 600_000,
  );
  // A transfer under way is the account's, and ends with its standing
  // (\`http/caller.ts\`): a clone does not run on after a suspension.
  const unhold = holdForCaller(request, () => proc.kill("SIGKILL"));
  void proc.exited.finally(() => {
    clearTimeout(timer);
    unhold();
    release();
  });
  request.signal.addEventListener("abort", () => proc.kill("SIGKILL"));
  // The client may have hung up while this call was queued behind other
  // transfers, in which case the listener above will never fire — nothing
  // is left to abort. Check once, now that there is a process to kill.
  if (request.signal.aborted) proc.kill("SIGKILL");

  return proc;
}

/**
 * The request body into git's stdin, counted against the service's ceiling
 * (\`http/limits.ts\`): a fetch's negotiation is small, a push's pack large;
 * past it git is stopped and the connection ends, nothing more read. A gzip
 * body is only ever negotiation (pack data is already zlib inside): it is
 * read whole within GZIP_MAX and inflated with a ceiling of its own, so a
 * small body that would inflate enormously is refused instead of filling
 * memory. Once git has exited — stopped, or done with input it would not
 * take — nothing more is written to it, and every write is awaited, so a
 * git that goes away mid-write is an error caught here, never one left
 * loose in the process.
 */
async function feedStdin(
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
  service: GitService,
  request: Request,
): Promise<void> {
  const stdin = proc.stdin;
  if (request.body === null) {
    await stdin.end();
    return;
  }
  let gone = false;
  void proc.exited.then(() => {
    gone = true;
  });
  const stop = (): void => {
    closeNow(request);
    proc.kill("SIGKILL");
  };
  const write = async (chunk: Uint8Array): Promise<void> => {
    const wrote: unknown = stdin.write(chunk);
    if (wrote instanceof Promise) await wrote;
    await stdin.flush();
  };
  try {
    if (request.headers.get("content-encoding") === "gzip") {
      const compressed = await readBounded(request, GZIP_MAX);
      if (compressed === "too_large") return stop();
      let inflated: Uint8Array;
      try {
        inflated = gunzipSync(compressed, { maxOutputLength: FETCH_MAX });
      } catch {
        return stop();
      }
      if (!gone) await write(inflated);
    } else {
      const max = service === "git-receive-pack" ? PUSH_MAX : FETCH_MAX;
      for await (const chunk of counted(request.body, max, stop)) {
        if (gone) break;
        await write(chunk);
      }
    }
    if (!gone) await stdin.end();
  } catch {
    // Git went away mid-write: the body has nowhere to go, and its answer
    // (or its absence) is the response's business.
    proc.kill("SIGKILL");
  }
}

/** A stream that yields `head` and then everything from `rest`. */
function prepend(
  head: Uint8Array,
  rest: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  let sentHead = false;
  return new ReadableStream({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(head);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
