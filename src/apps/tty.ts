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

import { shellCommand } from "./run_command.ts";
import { killTree, openCell, type Cell } from "./contain.ts";
import type { App as Forge } from "../app.ts";
import { getAppBySlug, type AppRecord } from "../core/apps.ts";
import { identityKey } from "./proxy.ts";
import { resolveAppEnv } from "../core/app_env.ts";
import { canEnterApp, canRead, canWrite, getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { SshSession } from "../ssh/server.ts";
import {
  buildEnvFromLabel,
  isEnvName,
  previewEnv,
  type EnvName,
} from "./data.ts";
import { appEnv, signalGroup } from "./process.ts";
import { appsRuntime } from "./runtime.ts";
import { openAppTty, type AppTtyHandle } from "./tty_registry.ts";
import { shellIdleMs } from "../machines/shell.ts";

const CRLF = "\r\n";

/** `notes` → production, `notes--12` → the preview of pull 12, `notes--b1a2b3c4` → the build at 1a2b3c4. */
export function parseAppLogin(
  login: string,
): { slug: string; env: EnvName } | undefined {
  const name = login.toLowerCase();
  const at = name.indexOf("--");
  if (at === -1)
    return isSlugLike(name) ? { slug: name, env: "production" } : undefined;
  const slug = name.slice(0, at);
  const number = name.slice(at + 2);
  const build = buildEnvFromLabel(number);
  if (isSlugLike(slug) && build !== undefined) return { slug, env: build };
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
  /** Fires when the host is gone; the program (and what it started) gets `SIGHUP`. */
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
 * Who may open an app's terminal or ask it a question over ssh: the one
 * gate, so every door refuses in the same words. An app you may not see is
 * not there.
 */
export function appGate(
  forge: Forge,
  user: User | undefined,
  target: { app: AppRecord },
): TtyRefusal | undefined {
  const repo = getRepoById(forge.db, target.app.repoId);
  if (!repo || !canRead(forge.db, repo, user)) return "not_found";
  if (target.app.access === "private" && user === undefined) return "private";
  // A private app's terminal is its writers' and crew's: a person the app
  // names may enter the app, not its terminal (#752).
  if (!canEnterApp(forge.db, repo, target.app, user, { named: false }))
    return "not_found";
  return undefined;
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
  const refused = appGate(forge, user, target);
  if (refused !== undefined) return err({ refusal: refused, detail: "" });
  const repo = getRepoById(forge.db, target.app.repoId)!;
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
    // An absorbed app's settings, as its process was started with.
    feature: runtime.featureFor(repo, target.app.id, target.env, live.dir),
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
  // The terminal is held exactly as the app is (`apps/contain.ts`).
  const cell = live.cell === undefined ? undefined : openCell(live.cell);
  const code = await serveTerminal(host, {
    command: shellCommand(live.tty),
    env,
    cwd: live.dir,
    cell,
    register: (program) => {
      forge.log.info("app terminal opened", {
        app: target.app.slug,
        env: target.env,
        user: user?.username ?? "guest",
      });
      return openAppTty(forge, {
        userId: user?.id,
        repository: `${repo.ownerName}/${repo.name}`,
        slug: target.app.slug,
        env: target.env,
        hangup: program.hangup,
        idleMs: () => shellIdleMs(forge.db),
      });
    },
  });
  return ok(code);
}

/**
 * Run `command` on a new pty for `host` until it exits: pty bytes to the
 * host (stamping the registry's output), host bytes and resizes to the pty
 * (stamping its input), a hangup when the host goes away, and the registry
 * entry forgotten however the program ends. `register` is told the started
 * program and returns the registry's handle for it.
 */
export async function serveTerminal(
  host: TtyHost,
  options: {
    command: string;
    env: Record<string, string>;
    cwd: string;
    cell: Cell | undefined;
    register: (program: TerminalProgram) => AppTtyHandle;
  },
): Promise<number> {
  let held: AppTtyHandle | undefined;
  const terminal = new Bun.Terminal({
    cols: Math.max(1, host.cols || 80),
    rows: Math.max(1, host.rows || 24),
    data: (_t, chunk) => {
      held?.output();
      host.write(chunk);
    },
  });
  const program = startTerminal(options.command, {
    terminal,
    env: options.env,
    cwd: options.cwd,
    cell: options.cell,
  });
  held = options.register(program);
  host.onData((chunk) => {
    held?.input();
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
  host.onClose?.(program.hangup);
  try {
    // `exited`, never the pty's own exit callback (see runEditor).
    return await program.exited;
  } finally {
    held.close();
    terminal.close();
  }
}

/** A terminal program started on a pty: its pid, its exit, and its hangup. */
export interface TerminalProgram {
  readonly pid: number;
  /** Resolves with the exit code once the program, and so its group, is gone. */
  readonly exited: Promise<number>;
  /** The host went away: what a closing terminal sends. */
  readonly hangup: () => void;
}

/** Where `setsid` is, found once; null on a host without util-linux. */
const SETSID = Bun.which("setsid");

/**
 * Start `command` (through `sh -c`) on `terminal`, held in `cell` when
 * there is one. Without a cell the program leads a process group of its
 * own, so a hangup reaches what it started (a server it left running, a
 * job sent to the background), not just the program; and once the program
 * has gone, whatever is left of its group is killed. Nothing a terminal
 * started runs on, with the environment's secrets, after the terminal has
 * closed. A cell's tree dies with bubblewrap.
 */
export function startTerminal(
  command: string,
  options: {
    terminal: Bun.Terminal;
    env: Record<string, string>;
    cwd: string;
    cell: Cell | undefined;
  },
): TerminalProgram {
  const { cell } = options;
  const argv = cell?.argv(command) ?? ["/bin/sh", "-c", command];
  // Bun's `terminal` gives the child the pty as its stdio but not as its
  // controlling terminal, so the kernel has no one to tell of a resize: no
  // SIGWINCH, and tmux never redraws at the new size (#9472). `setsid -c`
  // (util-linux, Essential on the image's Debian) makes the program lead a
  // session whose controlling terminal is the pty, in place: it is not a
  // group leader yet, so setsid execs rather than forks, the pid stays, and
  // the group is the program's own as `detached` made it.
  const ctty = SETSID !== null;
  const proc = Bun.spawn(ctty ? [SETSID, "-c", ...argv] : argv, {
    terminal: options.terminal,
    env: cell?.env(options.env) ?? options.env,
    cwd: options.cwd,
    detached: !ctty && cell === undefined,
  });
  const exited = proc.exited.then((code) => {
    cell?.close();
    if (cell === undefined) signalGroup(proc.pid, "SIGKILL");
    return code;
  });
  cell?.watch(proc.pid, () => killTree(proc.pid));
  const hangup = (): void => {
    if (cell === undefined) {
      // Hung up right after the start, `setsid` may not have made the group
      // yet: signal the program itself too, so the hangup is never lost.
      signalGroup(proc.pid, "SIGHUP");
    }
    try {
      proc.kill("SIGHUP");
    } catch {
      /* already gone */
    }
  };
  return { pid: proc.pid, exited, hangup };
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
