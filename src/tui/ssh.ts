/**
 * The SSH front door. One port answers two things: `ssh forge.example` opens
 * the terminal UI, and `git clone ssh://forge.example/owner/repo.git` runs an
 * exec channel through the same access checks the HTTP transport uses.
 *
 * The identity rule (see `session.ts`): `authorize` admits every well-formed
 * key, and what that key *is* decides who the session acts as. An unknown key
 * is a guest — public repos only, and a "Sign in" screen that links the key
 * on success. Nothing here can act as a user the presented key does not map
 * to.
 */

import { NOT_A_MEMBER } from "../core/roles.ts";
import { holdOpen } from "../http/caller.ts";
import { join } from "node:path";
import type { App as Forge } from "../app.ts";
import { findKeyByFingerprint, touchKey } from "../core/keys.ts";
import { canRead, canWrite, getRepo, type Repo } from "../core/repos.ts";
import { redirectFor } from "../core/transfer.ts";
import { sshCloneUrl } from "../ssh/command.ts";
import { getUserById, isActive, type User } from "../core/users.ts";
import { createRepo, repositoryLimitMessage, resolveOwner } from "../actions/repos.ts";
import { isPacksMirror, MIRROR_PUSH_REFUSED } from "../packs/owner.ts";
import { hookEnv } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
import { pushCap, storageChanged, storageRefusal, storageRefusedText, storageSentence } from "../core/storage.ts";
import { parseGitCommand, runGitService } from "../git/smart-ssh.ts";
import { serveSsh, type SshServer, type SshSession } from "../ssh/server.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { createForgeApp } from "./forge.ts";
import { appForLogin, attachAppTty } from "../apps/tty.ts";
import { servePulls } from "../apps/tty_pulls.ts";
import type { Terminal } from "./term/terminal.ts";
import type { TuiIdentity } from "./session.ts";
import { parseTalkAgain, parseTalkCommand, serveTalk, serveTalkAgain } from "./ssh-talk.ts";
import { parseTellCommand, serveTell } from "./ssh-tell.ts";

const CRLF = "\r\n";

/** Whether an address is this machine talking to itself. */
export function isLoopback(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  return a === "::1" || a === "localhost" || a.startsWith("127.");
}

/** A `Terminal` over an SSH channel — the whole SSH-specific surface. */
export function sshTerminal(
  session: SshSession,
  onFault: (error: unknown) => void,
): Terminal {
  let closed = false;
  return {
    // A peer on this machine is looking at this machine's screen: `o` can
    // open a browser for real, exactly as the stdio runner can. Any other
    // peer gets the link and the clipboard, and honest words.
    local: isLoopback(session.remoteAddress),
    // Getters, not a snapshot: `pty-req` may arrive after this object is
    // built, and `window-change` moves both of these mid-session.
    get term() {
      return session.term;
    },
    write(bytes) {
      if (!closed) session.write(bytes);
    },
    onInput(cb) {
      // A screen that throws must end this session and nothing else. The
      // channel layer already guards its own callbacks; this guard is what
      // turns a defect into a clean disconnect instead of a wedged session.
      session.onData((chunk) => {
        if (closed) return;
        try {
          cb(chunk);
        } catch (error) {
          onFault(error);
        }
      });
    },
    size() {
      // A client with no pty reports 0×0; the caller refuses those before we
      // get here, so the fallback is only ever belt and braces.
      return {
        cols: session.cols > 0 ? session.cols : 80,
        rows: session.rows > 0 ? session.rows : 24,
      };
    },
    // A getter, not a snapshot: `window-change` updates the channel's pixel
    // fields, and whoever asks next should get the window as it is now.
    get pixelSize() {
      return session.widthPx > 0 && session.heightPx > 0
        ? { width: session.widthPx, height: session.heightPx }
        : undefined;
    },
    onResize(cb) {
      session.onResize((cols, rows) => {
        try {
          cb(cols, rows);
        } catch {
          // One client's resize must never take the server down.
        }
      });
    },
    onClose(cb) {
      session.onClose(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      // Leaving the app is leaving the session: there is no shell behind us.
      session.exit(0);
    },
  };
}

/** Run the terminal UI for one shell session. */
export function attachTui(
  forge: Forge,
  session: SshSession,
  identity: TuiIdentity,
): void {
  // A pty request is the ask; its *size* may legitimately be 0×0 (OpenSSH
  // sends that whenever its own stdin is not a terminal), so `term` is what
  // decides, and the size falls back to 80×24 until a window-change arrives.
  if (session.term === undefined) {
    session.writeStderr(
      `forge: this is an interactive terminal — connect with a tty (ssh -t)${CRLF}`,
    );
    session.exit(1);
    return;
  }
  const { app } = createForgeApp(forge, identity, {
    terminal: sshTerminal(session, (error) => {
      forge.log.error("tui session fault", {
        error: String(error),
        peer: session.remoteAddress,
      });
      app.stop();
      session.exit(1);
    }),
    // Never process-level hooks: this is one of many sessions in a server.
    exitHooks: false,
  });
  app.start();
}

/** Resolve the account a presented key belongs to, or a guest. */
export function identityFor(forge: Forge, session: SshSession): TuiIdentity {
  const match = findKeyByFingerprint(forge.db, session.key.fingerprint);
  const found =
    match === undefined ? undefined : getUserById(forge.db, match.userId);
  // A suspended or removed account's key opens nothing: it is a guest.
  const user = found !== undefined && isActive(found) ? found : undefined;
  if (match !== undefined && user !== undefined)
    touchKey(forge.db, match.keyId);
  return {
    sshUsername: session.username,
    remoteAddress: session.remoteAddress,
    fingerprint: session.key.fingerprint,
    publicKey: session.key.line,
    ...(match === undefined || user === undefined
      ? {}
      : { keyId: match.keyId, user }),
  };
}

/**
 * Standing is checked when a key signs in, and again for as long as the
 * session lasts: when the owner suspends or removes the account, its open
 * sessions — a terminal, an app's tty, a clone still streaming — end there
 * and then, instead of acting on as a person who no longer may.
 */
export function endOnSuspension(
  forge: Forge,
  session: SshSession,
  user: User,
): void {
  const stop = forge.bus.subscribe((event) => {
    if (
      (event.kind === "account.suspended" || event.kind === "account.removed") &&
      event.payload["username"] === user.username
    ) {
      stop();
      end();
    }
  });
  // And held open under the account, so a suspension another process
  // wrote ends it on this one's sweep (\`http/caller.ts\`).
  const end = (): void => {
    if (session.ended) return;
    session.writeStderr(`${CRLF}forge: this account was suspended${CRLF}`);
    session.exit(1);
  };
  const unhold = holdOpen(forge.db, user.id, undefined, end);
  session.onClose(() => {
    stop();
    unhold();
  });
}

/** The execs an app's login answers besides git, by command word. */
const appExecs: Record<string, typeof servePulls> = Object.assign(
  Object.create(null) as Record<string, typeof servePulls>,
  { pulls: servePulls },
);

/**
 * What a forge does with an inbound SSH session: a shell is the TUI, an exec
 * is git, `tell`, or nothing. Never throws — a fault here would take the listener with
 * it, and one bad client must not.
 */
export function forgeSshSession(forge: Forge): (session: SshSession) => void {
  return (session) => {
    try {
      const identity = identityFor(forge, session);
      if (identity.user !== undefined)
        endOnSuspension(forge, session, identity.user);
      if (session.kind === "shell") {
        // The login name is decorative for the forge — any name opens the
        // terminal UI — unless it names an app, in which case it opens
        // that app's own terminal (docs/APPS.md).
        const app = appForLogin(forge, session.username);
        if (app !== undefined) attachAppTty(forge, session, identity.user, app);
        else attachTui(forge, session, identity);
        return;
      }
      // An exec on an app's login that git does not speak: a small table.
      const door = appForLogin(forge, session.username);
      const verb = session.command === undefined ? undefined : appExecs[session.command.trim()];
      if (door !== undefined && verb !== undefined) {
        verb(forge, session, identity.user, door);
        return;
      }
      // `tell <words>`: the crew, in one line. On an app's login it is the
      // app's crew, said from the app (through the terminal's own gate).
      const said = parseTellCommand(session.command);
      if (said !== undefined) {
        void serveTell(forge, session, identity.user, said, door).catch(
          (error: unknown) => {
            forge.log.error("tell over ssh failed", { error: String(error) });
            session.writeStderr(`forge: internal error${CRLF}`);
            session.exit(1);
          },
        );
        return;
      }
      // `talk <words>`: the forge's own agent, as the person.
      const talked = parseTalkCommand(session.command);
      if (talked !== undefined && door === undefined) {
        serveTalk(forge, session, identity.user, talked);
        return;
      }
      const again = parseTalkAgain(session.command);
      if (again !== undefined && door === undefined) {
        serveTalkAgain(forge, session, identity.user, again.how, again.words);
        return;
      }
      void serveGitCommand(forge, session, identity.user).catch(
        (error: unknown) => {
          forge.log.error("git over ssh failed", { error: String(error) });
          session.writeStderr(`forge: internal error${CRLF}`);
          session.exit(1);
        },
      );
    } catch (error) {
      forge.log.error("ssh session failed", { error: String(error) });
      session.writeStderr(`forge: internal error${CRLF}`);
      session.exit(1);
    }
  };
}

/**
 * Git over an exec channel. The access matrix is exactly the HTTP one:
 *   upload-pack  → `canRead`; a guest may read a public repo.
 *   receive-pack → a signed-in user with `canWrite`; push-to-create makes a
 *                  private repo when the target does not exist yet.
 * A repo you cannot see is "not found", the same answer a missing one gets.
 */
export async function serveGitCommand(
  forge: Forge,
  session: SshSession,
  user: User | undefined,
): Promise<void> {
  const parsed =
    session.command === undefined ? null : parseGitCommand(session.command);
  if (parsed === null) {
    session.writeStderr(
      `forge: only git is available over ssh; run 'ssh ${session.username}@host' for the terminal UI${CRLF}`,
    );
    session.exit(1);
    return;
  }

  const write = parsed.service === "git-receive-pack";
  let repo = getRepo(forge.db, parsed.owner, parsed.name);
  // A path a move left behind (#570): SSH has no redirect, so a fetch is
  // served from the new place with one line naming the new remote, and a
  // push is refused with that line — never applied, never push-to-create
  // taking the old path back by accident. Someone who cannot read the
  // repository gets the "not found" below, as for any missing path.
  const moved = repo === undefined ? redirectFor(forge.db, parsed.owner, parsed.name) : undefined;
  if (moved !== undefined && canRead(forge.db, moved, user)) {
    session.writeStderr(`forge: ${movedLine(forge, parsed, moved, write)}${CRLF}`);
    if (write) {
      session.exit(1);
      return;
    }
    repo = moved;
  }
  if (!repo && write && user) {
    // Push-to-create, the same rule as smart HTTP: an authed owner (or org
    // writer) pushing to a repo that does not exist makes it.
    const created = await createRepo(forge, user, {
      owner: parsed.owner,
      name: parsed.name,
      visibility: "private",
    });
    if (created.ok) repo = created.value;
    else if (created.error === "storage_limit") {
      const ownerId = resolveOwner(forge, user, parsed.owner) ?? user.id;
      session.writeStderr(
        `forge: ${storageRefusedText(storageSentence(forge, ownerId) ?? "at the limit")}${CRLF}`,
      );
      session.exit(1);
      return;
    } else if (created.error === "not_member") {
      session.writeStderr(`forge: Not made: ${NOT_A_MEMBER}${CRLF}`);
      session.exit(1);
      return;
    } else if (created.error === "repository_limit") {
      session.writeStderr(
        `forge: Not made: ${repositoryLimitMessage(forge, user, resolveOwner(forge, user, parsed.owner) ?? user.id)}${CRLF}`,
      );
      session.exit(1);
      return;
    }
  }

  if (write && repo !== undefined && isPacksMirror(repo) && canRead(forge.db, repo, user)) {
    session.writeStderr(`forge: ${MIRROR_PUSH_REFUSED}${CRLF}`);
    session.exit(1);
    return;
  }

  const allowed =
    repo !== undefined &&
    (write
      ? user !== undefined && canWrite(forge.db, repo, user)
      : canRead(forge.db, repo, user));
  if (!repo || !allowed) {
    session.writeStderr(
      `forge: repository not found: ${parsed.owner}/${parsed.name}${CRLF}`,
    );
    session.exit(1);
    return;
  }

  const dir = repoDir(forge.reposRoot, repo.ownerName, repo.name);
  // The storage limit: a git error before anything is written (#919).
  const refused =
    write && user ? await storageRefusal(forge, user, repo.ownerId, repo) : undefined;
  if (refused !== undefined) {
    session.writeStderr(
      `forge: ${storageRefusedText(refused)}${CRLF}`,
    );
    session.exit(1);
    return;
  }
  const env: Record<string, string> = write
    ? {
        ...hookEnv({
          socketPath: forge.hookAddress.current,
          secret: forge.hookSecret,
          repoId: repo.id,
          actorId: user?.id ?? "",
        }),
        ...(user ? await pushCap(forge, user, repo.ownerId, repo) : {}),
      }
    : {};
  // The client asks for protocol v2 by sending GIT_PROTOCOL through the
  // channel's `env` requests; forward it inside git's own grammar only.
  const protocol = session.env["GIT_PROTOCOL"];
  if (protocol !== undefined && /^[A-Za-z0-9=:._-]{1,200}$/.test(protocol))
    env.GIT_PROTOCOL = protocol;

  await runGitService(dir, parsed.service, session, { env });
  if (write) storageChanged(forge, repo.ownerId);
}

/** The one stderr line a moved repository's old SSH path answers with. */
export function movedLine(
  forge: Forge,
  from: { owner: string; name: string },
  to: Repo,
  push: boolean,
): string {
  const path = `${to.ownerName}/${to.name}`;
  const remote = sshCloneUrl(forge, to.ownerName, to.name) ?? path;
  return push
    ? `${from.owner}/${from.name} moved to ${path}. Nothing was pushed: run git remote set-url origin ${remote} and push again.`
    : `${from.owner}/${from.name} moved to ${path}; fetching from there. Point the remote at it: git remote set-url origin ${remote}`;
}

export interface ForgeSshOptions {
  /** 0 for an ephemeral port; the real one lands in `app.config.sshPort`. */
  port: number;
  hostname?: string;
  /** @default <dataDir>/ssh */
  hostKeyDir?: string;
}

/**
 * Start the forge's SSH listener. Every well-formed key is admitted — the
 * session decides what that key can do, not the transport.
 */
export async function serveForgeSsh(
  forge: Forge,
  options: ForgeSshOptions,
): Promise<SshServer> {
  const server = await serveSsh({
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    hostKeyDir: options.hostKeyDir ?? join(forge.config.dataDir, "ssh"),
    log: forge.log,
    // Guests are welcome: the key is an identity, not a permit.
    authorize: () => true,
    onSession: forgeSshSession(forge),
  });
  // One answer for "what port is ssh on", which the web reads for clone URLs.
  forge.config.sshPort = server.port;
  forge.config.sshHostKey = server.hostKey.fingerprint;
  return server;
}

/**
 * `serveForgeSsh` as a value: the terminal is optional, the forge is not. A
 * port that will not bind (or any other failure starting the listener) comes
 * back as an Err the boot logs once, and the web keeps serving.
 */
export async function startForgeSsh(
  forge: Forge,
  options: ForgeSshOptions,
): Promise<Result<SshServer, Error>> {
  try {
    return ok(await serveForgeSsh(forge, options));
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
