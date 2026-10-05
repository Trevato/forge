/**
 * A terminal for every app. `ssh -p 2222 notes@forge` opens the app's own
 * terminal interface — the `tty` command in its `forge.json` — on a real
 * pty, in the deployed checkout, with the environment's own variables;
 * `notes--12@forge` opens the preview of pull 12's. The login name picks
 * the app; the key still decides who you are, and a private app answers
 * only to someone who can write its repository or is on its crew, exactly
 * as the proxy does.
 *
 * The same bridge serves the forge's own terminal UI: press `t` on an app
 * and the UI suspends itself, the app's terminal runs on the same pty, and
 * the UI comes back when it exits — one connection, two programs in turn,
 * the way an operator's editor already runs.
 *
 * The bridge is `runEditor`'s: pty bytes to the host verbatim, host bytes to
 * the pty, resizes through, SIGHUP when the host goes away. The app's
 * terminal is any program that draws on a tty; the scaffold ships a small
 * one.
 */

import type { App as Forge } from "../app.ts";
import { getAppBySlug, type AppRecord } from "../core/apps.ts";
import { identityKey } from "./proxy.ts";
import { resolveAppEnv } from "../core/app_env.ts";
import { canEnterApp, canRead, canWrite, getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { SshSession } from "../ssh/server.ts";
import { isEnvName, previewEnv, type EnvName } from "./data.ts";
import { appEnv } from "./process.ts";
import { appsRuntime } from "./runtime.ts";

const CRLF = "\r\n";

/** `notes` → production, `notes--12` → the preview of pull 12. */
export function parseAppLogin(
  login: string,
): { slug: string; env: EnvName } | undefined {
  const name = login.toLowerCase();
  const at = name.indexOf("--");
  if (at === -1)
    return isSlugLike(name) ? { slug: name, env: "production" } : undefined;
  const slug = name.slice(0, at);
  const number = name.slice(at + 2);
  if (!isSlugLike(slug) || !/^[1-9]\d*$/.test(number)) return undefined;
  const env = previewEnv(Number(number));
  return isEnvName(env) ? { slug, env } : undefined;
}

const isSlugLike = (s: string): boolean =>
  s.length > 0 && s.length <= 40 && /^[a-z0-9](?:-?[a-z0-9])*$/.test(s);

/** The app a login name addresses, when one exists. */
export function appForLogin(
  forge: Forge,
  login: string,
): { app: AppRecord; env: EnvName } | undefined {
  const parsed = parseAppLogin(login);
  if (parsed === undefined) return undefined;
  const app = getAppBySlug(forge.db, parsed.slug);
  return app ? { app, env: parsed.env } : undefined;
}

/**
 * What a terminal program needs of whoever is holding the other end: a
 * size, a `TERM`, bytes out, bytes and resizes in. An SSH channel is one;
 * the terminal UI's raw host, while it is suspended, is another.
 */
export interface TtyHost {
  readonly cols: number;
  readonly rows: number;
  readonly term: string | undefined;
  write(bytes: Uint8Array): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  /** Fires when the host is gone; the program gets `SIGHUP`. */
  onClose?(cb: () => void): void;
}

export type TtyRefusal =
  | "not_found"
  | "private"
  | "no_tty"
  | "not_running"
  | "no_pty";

/** The sentence a refusal is said with. */
export function ttyRefusalText(
  refusal: TtyRefusal,
  name: string,
  detail = "",
): string {
  switch (refusal) {
    case "not_found":
      return `no app named ${name}`;
    case "private":
      return `${name} is private: sign in to the forge first, so your key is known`;
    case "no_tty":
      return `${name} has no terminal interface — give it one with "tty" in forge.json`;
    case "not_running":
      return `${name} is not running: ${detail}`;
    case "no_pty":
      return "this is a terminal interface — connect with a tty (ssh -t)";
  }
}

/**
 * Run the app's terminal on `host` until it exits. Every reason it cannot
 * is a refusal the caller says in words; a program that ran resolves with
 * its exit code once the pty is closed.
 */
export async function runAppTty(
  forge: Forge,
  host: TtyHost,
  user: User | undefined,
  target: { app: AppRecord; env: EnvName },
): Promise<Result<number, { refusal: TtyRefusal; detail: string }>> {
  const repo = getRepoById(forge.db, target.app.repoId);
  // The same conflation as everywhere: an app you may not see is not there.
  if (!repo || !canRead(forge.db, repo, user))
    return err({ refusal: "not_found", detail: "" });
  if (target.app.access === "private" && user === undefined)
    return err({ refusal: "private", detail: "" });
  // A private app's terminal is its writers' and crew's, as the app is.
  if (!canEnterApp(forge.db, repo, target.app.access, user))
    return err({ refusal: "not_found", detail: "" });
  if (host.term === undefined) return err({ refusal: "no_pty", detail: "" });
  const runtime = appsRuntime(forge);
  // A terminal opened on a sleeping environment wakes it first.
  if (runtime?.envStatus(target.app, target.env)?.state === "asleep")
    await runtime.wake(target.app, target.env);
  const live = runtime?.liveFor(target.app, target.env);
  if (runtime === undefined || live === undefined) {
    const status = runtime?.envStatus(target.app, target.env);
    const detail =
      status === undefined
        ? "nothing is running there"
        : status.state === "deploying"
          ? "a new version is starting; try again in a moment"
          : (status.error ?? `it is ${status.state}`);
    return err({ refusal: "not_running", detail });
  }
  if (live.tty === null) return err({ refusal: "no_tty", detail: "" });

  const terminal = new Bun.Terminal({
    cols: Math.max(1, host.cols || 80),
    rows: Math.max(1, host.rows || 24),
    data: (_t, chunk) => host.write(chunk),
  });
  const env = appEnv({
    port: live.port,
    dataDir: live.dataDir,
    env: live.env,
    url: live.url,
    commitOid: live.commitOid,
    forgeUrl: runtime.options.forgeUrl,
    identityKey: identityKey(forge.config.dataDir, target.app.id),
    ssh: runtime.sshFor(target.app, target.env),
    // The terminal is the app too: it opens the same database with the
    // same secrets, so it is handed the same environment.
    vars: resolveAppEnv(
      forge.db,
      forge.config.dataDir,
      target.app.id,
      target.env,
    ),
  });
  env["TERM"] = host.term;
  env["COLORTERM"] = "truecolor";
  env["FORGE_APP_TTY"] = "1";
  // The terminal's identity, the same three tiers the proxy speaks: a
  // guest is nobody, a reader is a user, a writer of the repository is admin.
  env["FORGE_APP_USER"] = user?.username ?? "";
  env["FORGE_APP_USER_ID"] = user?.id ?? "";
  env["FORGE_APP_USER_ROLE"] =
    user === undefined ? "" : canWrite(forge.db, repo, user) ? "admin" : "user";
  const proc = Bun.spawn(["/bin/sh", "-c", `exec ${live.tty}`], {
    terminal,
    env,
    cwd: live.dir,
  });
  forge.log.info("app terminal opened", {
    app: target.app.slug,
    env: target.env,
    user: user?.username ?? "guest",
  });

  host.onData((chunk) => {
    if (terminal.closed) return;
    try {
      terminal.write(chunk);
    } catch {
      /* the program is gone; the keystroke has nowhere to go */
    }
  });
  host.onResize((cols, rows) => {
    if (terminal.closed) return;
    try {
      terminal.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      /* same race, same answer */
    }
  });
  const hangup = (): void => {
    try {
      proc.kill("SIGHUP");
    } catch {
      /* already gone */
    }
  };
  host.onClose?.(hangup);
  try {
    // `proc.exited`, never the pty's own exit callback (see runEditor).
    return ok(await proc.exited);
  } finally {
    terminal.close();
  }
}

/**
 * Attach an SSH session to the app's terminal. Every refusal is a sentence
 * on stderr and a non-zero exit — a shell that goes quiet is the one thing
 * a person cannot act on.
 */
export function attachAppTty(
  forge: Forge,
  session: SshSession,
  user: User | undefined,
  target: { app: AppRecord; env: EnvName },
): void {
  const host: TtyHost = {
    get cols() {
      return session.cols;
    },
    get rows() {
      return session.rows;
    },
    term: session.term,
    write: (bytes) => {
      if (!session.ended) session.write(bytes);
    },
    onData: (cb) => session.onData(cb),
    onResize: (cb) => session.onResize(cb),
    onClose: (cb) => session.onClose(cb),
  };
  void runAppTty(forge, host, user, target)
    .then((ran) => {
      if (ran.ok) {
        if (!session.ended) session.exit(ran.value);
        return;
      }
      session.writeStderr(
        `forge: ${ttyRefusalText(ran.error.refusal, session.username, ran.error.detail)}${CRLF}`,
      );
      session.exit(1);
    })
    .catch((error: unknown) => {
      forge.log.error("app terminal failed", { error: String(error) });
      session.writeStderr(`forge: internal error${CRLF}`);
      session.exit(1);
    });
}
