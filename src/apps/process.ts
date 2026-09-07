/**
 * One deployment's process: install, test, start, and wait until it
 * answers. Everything the app is handed is listed here and nothing else
 * reaches it — the forge's own environment carries secrets, and a child
 * inherits exactly what `childEnv` names (rule 8 in docs/APPS.md).
 *
 * Commands run through `sh -c` with an `exec` in front, so the shell
 * replaces itself with the app and a signal to the pid is a signal to the
 * app, not to a shell that would swallow it.
 */

import type { AppManifest } from "./manifest.ts";
import type { EnvName } from "./data.ts";
import { envPull } from "./data.ts";
import { isReservedAppEnvName } from "../core/app_env.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface ProcessHandle {
  readonly pid: number;
  readonly port: number;
  /** Resolves with the exit code once the process has ended. */
  readonly exited: Promise<number>;
  /** SIGTERM, a grace period, then SIGKILL. Resolves once it is gone. */
  stop(): Promise<void>;
}

export interface StartInput {
  readonly dir: string;
  readonly dataDir: string;
  readonly manifest: AppManifest;
  readonly env: EnvName;
  readonly url: string;
  readonly commitOid: string;
  readonly forgeUrl: string;
  /** The `ssh …` that opens this environment's terminal, when SSH is on. */
  readonly ssh?: string | undefined;
  /** The operator's variables for this app (`core/app_env.ts`). */
  readonly vars?: Record<string, string> | undefined;
  readonly log: (line: string) => void;
  /** Aborting cancels whatever step is in flight and fails the start. */
  readonly signal: AbortSignal;
}

export type StartStage = "install" | "test" | "start" | "ready";

export interface StartError {
  readonly stage: StartStage;
  readonly message: string;
}

const STEP_TIMEOUT_MS = 10 * 60_000;
const STOP_GRACE_MS = 5_000;
const HEALTH_INTERVAL_MS = 250;

/**
 * The environment every child starts from. Explicit, and short: the path,
 * the home, who the operator is (the macOS keychain answers to `USER`, and
 * Claude Code's own login lives there), a locale, a temp dir.
 */
export function childEnv(
  extra: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/",
    LANG: process.env["LANG"] ?? "C.UTF-8",
  };
  for (const name of ["USER", "LOGNAME", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return { ...base, ...extra };
}

/** What an app is told about where it runs. */
export function appEnv(input: {
  port: number;
  dataDir: string;
  env: EnvName;
  url: string;
  commitOid: string;
  forgeUrl: string;
  /** The exact `ssh …` that opens this environment's terminal, if any. */
  ssh?: string | undefined;
  /** The operator's variables: an admin password, an API key. */
  vars?: Record<string, string> | undefined;
}): Record<string, string> {
  const pull = envPull(input.env);
  // The operator's variables go underneath everything the forge names, so
  // a stored `PORT` or `FORGE_APP_DATA` can never redirect the app. The
  // write path refuses those names; this is the same rule kept where it
  // matters, in case that path is ever bypassed.
  const env = {
    ...operatorVars(input.vars),
    ...childEnv({
      PORT: String(input.port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      FORGE_APP_ENV: input.env === "production" ? "production" : "preview",
      FORGE_APP_DATA: input.dataDir,
      FORGE_APP_URL: input.url,
      FORGE_APP_COMMIT: input.commitOid,
      FORGE_URL: input.forgeUrl,
      ...(pull === undefined ? {} : { FORGE_APP_PULL: String(pull) }),
      // Printed verbatim by an app that tells people how to reach its
      // terminal; a guessed form (`you@app.host`) reaches the forge instead.
      ...(input.ssh === undefined ? {} : { FORGE_APP_SSH: input.ssh }),
    }),
  };
  // The operator's login name is for the keychain (an agent's Claude Code
  // needs it); an app has no business knowing it, and a guest in a chat
  // should not be greeted by it.
  delete env["USER"];
  delete env["LOGNAME"];
  return env;
}

/** The operator's variables minus any name the forge owns. */
function operatorVars(
  vars: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (!isReservedAppEnvName(name)) out[name] = value;
  }
  return out;
}

/**
 * Run a step to completion, streaming its output. A non-zero exit, a
 * timeout, or an abort is an Err with the reason a person would want.
 */
export async function runStep(
  name: string,
  command: string,
  options: {
    cwd: string;
    env: Record<string, string>;
    log: (line: string) => void;
    signal: AbortSignal;
    timeoutMs?: number;
  },
): Promise<Result<void, string>> {
  options.log(`$ ${command}`);
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = options.timeoutMs ?? STEP_TIMEOUT_MS;
  let why: string | undefined;
  const timer = setTimeout(() => {
    why = `${name} took longer than ${Math.round(timeoutMs / 1000)}s`;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const onAbort = (): void => {
    why = `${name} cancelled`;
    proc.kill("SIGKILL");
  };
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [, , code] = await Promise.all([
      pump(proc.stdout, options.log),
      pump(proc.stderr, options.log),
      proc.exited,
    ]);
    if (why !== undefined) return err(why);
    if (code !== 0) return err(`${name} exited with code ${code}`);
    return ok();
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Install, test, start, and wait for the app to answer on its port.
 * Returns the running process; on failure the process (if it started) is
 * already gone.
 */
export async function startProcess(
  input: StartInput,
): Promise<Result<ProcessHandle, StartError>> {
  const { manifest, log } = input;
  const stepEnv = childEnv({
    CI: "1",
    FORGE_APP_ENV: input.env === "production" ? "production" : "preview",
  });

  if (manifest.install !== null) {
    const installed = await runStep("install", manifest.install, {
      cwd: input.dir,
      env: stepEnv,
      log,
      signal: input.signal,
    });
    if (!installed.ok)
      return err({ stage: "install", message: installed.error });
  }
  if (manifest.test !== null) {
    const tested = await runStep("test", manifest.test, {
      cwd: input.dir,
      env: stepEnv,
      log,
      signal: input.signal,
    });
    if (!tested.ok) return err({ stage: "test", message: tested.error });
  }
  if (input.signal.aborted)
    return err({ stage: "start", message: "cancelled" });

  const port = freePort();
  log(`$ ${manifest.run}  (PORT=${port})`);
  const proc = Bun.spawn(["/bin/sh", "-c", `exec ${manifest.run}`], {
    cwd: input.dir,
    env: appEnv({
      port,
      dataDir: input.dataDir,
      env: input.env,
      url: input.url,
      commitOid: input.commitOid,
      forgeUrl: input.forgeUrl,
      ssh: input.ssh,
      vars: input.vars,
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Output is pumped for the life of the process, not just the start.
  const recent: string[] = [];
  const remember = (line: string): void => {
    recent.push(line);
    if (recent.length > 20) recent.shift();
    log(line);
  };
  void pump(proc.stdout, remember);
  void pump(proc.stderr, remember);

  const handle: ProcessHandle = {
    pid: proc.pid,
    port,
    exited: proc.exited,
    stop: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      const gone = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(STOP_GRACE_MS).then(() => false),
      ]);
      if (!gone) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    },
  };

  const ready = await waitUntilReady({
    port,
    path: manifest.health,
    timeoutMs: manifest.ready * 1000,
    exited: proc.exited,
    signal: input.signal,
  });
  if (!ready.ok) {
    await handle.stop();
    const tail =
      recent.length > 0
        ? ` — last output: ${recent.slice(-3).join(" | ")}`
        : "";
    return err({
      stage: ready.error.stage,
      message: ready.error.message + tail,
    });
  }
  log(`ready: ${input.url}`);
  return ok(handle);
}

/**
 * Poll the health path until the app answers. Any HTTP answer below 500
 * counts — a 404 on `/` is an app that is up and has no root page — and an
 * exit, an abort, or the deadline is a failure with the reason.
 */
async function waitUntilReady(input: {
  port: number;
  path: string;
  timeoutMs: number;
  exited: Promise<number>;
  signal: AbortSignal;
}): Promise<Result<void, StartError>> {
  const deadline = Date.now() + input.timeoutMs;
  let exitCode: number | undefined;
  void input.exited.then((code) => {
    exitCode = code;
  });
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    if (input.signal.aborted)
      return err({ stage: "start", message: "cancelled" });
    if (exitCode !== undefined)
      return err({
        stage: "start",
        message: `exited with code ${exitCode} before answering`,
      });
    try {
      const response = await fetch(
        `http://127.0.0.1:${input.port}${input.path}`,
        {
          signal: AbortSignal.timeout(2_000),
          redirect: "manual",
        },
      );
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.status < 500) return ok();
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(HEALTH_INTERVAL_MS);
  }
  return err({
    stage: "ready",
    message:
      lastStatus === undefined
        ? `no answer on ${input.path} within ${Math.round(input.timeoutMs / 1000)}s`
        : `${input.path} answered ${lastStatus} for ${Math.round(input.timeoutMs / 1000)}s`,
  });
}

/** A port the OS says is free right now. */
export function freePort(): number {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

/** Read a stream as lines, calling `onLine` for each; never throws. */
export async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let carry = "";
  try {
    for await (const chunk of stream) {
      carry += decoder.decode(chunk, { stream: true });
      let at = carry.indexOf("\n");
      while (at !== -1) {
        onLine(carry.slice(0, at).replace(/\r$/, ""));
        carry = carry.slice(at + 1);
        at = carry.indexOf("\n");
      }
    }
    carry += decoder.decode();
    if (carry !== "") onLine(carry);
  } catch {
    // The process went away mid-read; whatever arrived was delivered.
  }
}
