/**
 * A writer's shell into a machine (#9471): a WebSocket at
 * `/:owner/:name/machines/:machine/shell` that a signed-in person with write
 * permission on the repository may open, from this forge's own pages only
 * (the Origin must be the forge's). It runs tmux on a real pty
 * (`Bun.spawn({terminal})`), held in a cell (`apps/contain.ts`) — the same
 * bubblewrap the forge holds repository code in — with the machine's memory
 * and CPU ceilings and no reach beyond the forge, save the repository's own
 * production and previews when its machine says `apps` (`shellReach`). A forge that cannot hold a
 * cell refuses the shell rather than hand out one on the host.
 *
 * One session per person, repository and machine: a second connection (a
 * second tab, a reload) joins the session that is running and sees the same
 * screen. Binary frames are keystrokes in and screen bytes out; a text frame
 * is JSON and says only `{"type":"resize","cols":n,"rows":n}`. The session
 * ends when its program exits or after the idle limit with no keystroke and
 * no output, and each one is a row in `machine_sessions`: machine, owner, start, end and why.
 *
 * No text a person sends ever reaches a command line: the command is a
 * constant, and the names in the path only pick a row and a directory after
 * they have been validated.
 */

import { existsSync, mkdirSync } from "node:fs";
import { cellHides } from "../spawn/hosted-mark.ts";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { cellCounters, openCell, resolveLimits, type Cell, type CellSpec } from "../apps/contain.ts";
import { appTtysOf, stopAllAppTtys, stopAppTty, stopIdleAppTtys } from "../apps/tty_registry.ts";
import { startTerminal, type TerminalProgram } from "../apps/tty.ts";
import { scheduleClock } from "../apps/feature_schedule.ts";
import { holdOpen } from "../http/caller.ts";
import { canWrite, getRepo, getRepoById, type Repo } from "../core/repos.ts";
import { getUserById, isActive } from "../core/users.ts";
import { isSafeName } from "../git/guard.ts";
import type { User } from "../core/users.ts";
import { repoMachines } from "../crew/machines_read.ts";
import { reachableApps, type Machine } from "../crew/machines.ts";
import { ownApp, ownAppUrls } from "../crew/app_hosts.ts";
import { limitValue } from "../settings/limits.ts";
import { id as newId } from "../kernel/id.ts";
import { readFileAt } from "../apps/checkout.ts";
import { parseManifest } from "../apps/manifest.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { ensureCheckout, prepareHome, shellPlan, CHECKOUT_DIR, type ShellPlan } from "./rc.ts";

// ---- the route ----

export interface ShellTarget {
  readonly owner: string;
  readonly name: string;
  readonly machine: string;
}

const MACHINE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The repository and machine a shell path names, or undefined when it names none. */
export function shellTarget(pathname: string): ShellTarget | undefined {
  const parts = pathname.split("/");
  if (parts.length !== 6 || parts[0] !== "" || parts[3] !== "machines" || parts[5] !== "shell")
    return undefined;
  const [, owner, name, , machine] = parts as [string, string, string, string, string];
  if (!isSafeName(owner) || !isSafeName(name) || !MACHINE_NAME.test(machine)) return undefined;
  return { owner, name, machine };
}

/** Same origin, strictly: a browser always sends Origin on a WebSocket, so none is a refusal. */
function sameOrigin(request: Request, forgeUrl: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).origin === forgeUrl.origin;
  } catch {
    return false;
  }
}

export type ShellRefusal = "not_found" | "forbidden" | "busy";

export interface ShellGrant {
  readonly repo: Repo;
  readonly machine: Machine;
  readonly user: User;
  readonly sessionId: string | undefined;
  /** The app's own `tty` command at the default branch's tip, for the greeting. */
  readonly tty?: string | null;
}

/**
 * Who may open this shell, decided before the upgrade. A repository the
 * caller cannot see, or a machine it does not declare, is `not_found`; a
 * reader, a token, a cross-origin page is `forbidden`.
 */
export async function mayOpenShell(
  app: App,
  request: Request,
  forgeUrl: URL,
  target: ShellTarget,
  auth: { user: User | undefined; via: string; sessionId?: string | undefined },
): Promise<{ ok: true; grant: ShellGrant } | { ok: false; refusal: ShellRefusal }> {
  const repo = getRepo(app.db, target.owner, target.name);
  const user = auth.user;
  if (repo === undefined) return { ok: false, refusal: "not_found" };
  // A browser identity only: a token cannot open a shell.
  if (user === undefined || (auth.via !== "session" && auth.via !== "edge"))
    return { ok: false, refusal: repo.visibility === "public" ? "forbidden" : "not_found" };
  if (!sameOrigin(request, forgeUrl)) return { ok: false, refusal: "forbidden" };
  if (!canWrite(app.db, repo, user))
    return { ok: false, refusal: repo.visibility === "public" ? "forbidden" : "not_found" };
  const config = await repoMachines(app, repo);
  const machine = config.machines.find((m) => m.name === target.machine);
  if (machine === undefined) return { ok: false, refusal: "not_found" };
  const grant = { repo, machine, user, sessionId: auth.sessionId, tty: await appTty(app, repo) };
  if (!roomFor(app, grant)) return { ok: false, refusal: "busy" };
  // The first connection clones; async, so no other request waits on it.
  await ensureCheckout(
    repoDir(app.reposRoot, repo.ownerName, repo.name),
    workspace(app, repo, machine, user.id),
  );
  return { ok: true, grant };
}

/** The `tty` command forge.json declares at the default branch's tip, or null. */
export async function appTty(app: App, repo: Repo): Promise<string | null> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return null;
  const parsed = parseManifest(await readFileAt(dir, tip, "forge.json"), undefined);
  return parsed.ok ? parsed.value.tty : null;
}

// ---- frames ----

export const RESIZE = { cols: { min: 1, max: 500 }, rows: { min: 1, max: 300 } } as const;

/** A text frame's resize, or undefined for anything else. */
export function parseControl(text: string): { cols: number; rows: number } | undefined {
  if (text.length > 200) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { type, cols, rows } = value as Record<string, unknown>;
  if (type !== "resize") return undefined;
  const fits = (n: unknown, r: { min: number; max: number }): n is number =>
    Number.isInteger(n) && (n as number) >= r.min && (n as number) <= r.max;
  if (!fits(cols, RESIZE.cols) || !fits(rows, RESIZE.rows)) return undefined;
  return { cols, rows };
}

export interface PtySize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * The sizes to give the pty for a resize frame, in order. A new size is set
 * once. A connection's first frame at the size the pty already has (a
 * reload, a second tab) passes through one row less first: the kernel only
 * signals a change, and tmux redraws the whole screen on the signal, so the
 * page that joined sees the screen rather than a blank one. A later frame at
 * the same size changes nothing.
 */
export function resizePlan(current: PtySize, next: PtySize, firstFromPeer: boolean): PtySize[] {
  if (current.cols !== next.cols || current.rows !== next.rows) return [next];
  if (!firstFromPeer) return [];
  return [{ cols: next.cols, rows: next.rows > RESIZE.rows.min ? next.rows - 1 : next.rows + 1 }, next];
}

/** How long the pty holds the nudged size before the real one, so the program sees two changes. */
export const REDRAW_NUDGE_MS = 30;

// ---- the records ----

export type EndReason = "exit" | "idle" | "stopped" | "revoked" | "failed";

export interface SessionRecord {
  readonly id: string;
  readonly machine: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly endReason: EndReason | undefined;
}

export function recordStart(db: Database, repoId: string, machine: string, ownerId: string): string {
  const row = newId();
  db.query(
    "INSERT INTO machine_sessions (id, repo_id, machine, owner_id, started_at) VALUES (?, ?, ?, ?, ?)",
  ).run(row, repoId, machine, ownerId, new Date().toISOString());
  return row;
}

export function recordEnd(db: Database, row: string, reason: EndReason): void {
  db.query(
    "UPDATE machine_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
  ).run(new Date().toISOString(), reason, row);
}

/**
 * At boot, every row still open belongs to a forge that stopped or crashed
 * without ending it: no shell survives its forge, so each is closed as
 * `stopped`. Returns how many.
 */
export function closeStaleSessions(db: Database): number {
  return db
    .query("UPDATE machine_sessions SET ended_at = ?, end_reason = 'stopped' WHERE ended_at IS NULL")
    .run(new Date().toISOString()).changes;
}

/** The repository's last sessions, newest first (index `machine_sessions_repo_started`). */
export function lastSessions(db: Database, repoId: string, limit = 20): SessionRecord[] {
  return db
    .query<
      { id: string; machine: string; owner_id: string; username: string | null; started_at: string; ended_at: string | null; end_reason: EndReason | null },
      [string, number]
    >(
      `SELECT s.id, s.machine, s.owner_id, u.username, s.started_at, s.ended_at, s.end_reason
         FROM machine_sessions s LEFT JOIN user u ON u.id = s.owner_id
        WHERE s.repo_id = ? ORDER BY s.started_at DESC LIMIT ?`,
    )
    .all(repoId, limit)
    .map((r) => ({
      id: r.id,
      machine: r.machine,
      ownerId: r.owner_id,
      ownerName: r.username ?? "someone",
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      endReason: r.end_reason ?? undefined,
    }));
}

/** How each end reads, on the page and in the terminal. */
export const ENDED: Record<EndReason, string> = {
  exit: "the shell exited",
  idle: "idle too long",
  stopped: "the forge stopped",
  revoked: "its owner could no longer write here",
  failed: "the shell could not start",
};

// ---- the sessions ----

/** What a socket carries: its grant, and the session it joined once open. */
export interface ShellSocket {
  readonly shell: ShellGrant & { readonly app: App };
  joined?: Session;
  release?: () => void;
  /** This connection has sent a size; its first one redraws a joined screen (`resizePlan`). */
  sized?: boolean;
}

type Peer = Bun.ServerWebSocket<ShellSocket>;

interface Session {
  readonly key: string;
  readonly userId: string;
  readonly repoId: string;
  readonly row: string;
  readonly terminal: Bun.Terminal;
  readonly program: TerminalProgram;
  readonly peers: Set<Peer>;
  /** The pty's size, as last set. */
  size: PtySize;
  lastInput: number;
  /** When the program last printed: a running build is not idle. */
  lastOutput: number;
  ended: boolean;
  readonly timer: ReturnType<typeof setInterval>;
}

export interface ShellOptions {
  /**
   * No keystroke and no output for this long ends the session. A function is
   * asked at every check, so a changed setting governs the next one.
   */
  readonly idleMs: number | (() => number);
  /**
   * Whether this forge can hold a cell. Without one the shell is refused —
   * except where a test says `uncontained`, on purpose, to run the bridge.
   */
  readonly contain: "cell" | "uncontained" | "refuse";
  /** The command the pty runs: constant, never built from a request. */
  readonly command: string;
  /** Whether leaving the command keeps the session (tmux holds it); said in the greeting. Defaults to no. */
  readonly detaches?: boolean;
  /** How often a session asks again whether its owner may still write; defaults to `CHECK_MS`. */
  readonly checkMs?: number;
  /** Handshakes one person may make in a minute; defaults to `HANDSHAKES_PER_MINUTE`. */
  readonly handshakesPerMinute?: number;
}

/** Sessions the whole forge runs at once, and one person runs at once. */
export const MAX_SESSIONS = { forge: 16, person: 3 } as const;
/** Handshakes one person may make in a minute. */
export const HANDSHAKES_PER_MINUTE = 20;
/** The largest keystroke frame: a paste, not a file. */
export const MAX_INPUT_BYTES = 64 * 1024;
/** Output waiting on a peer that is not reading, past which it is closed. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
export const CHECK_MS = 5_000;

/** tmux where the machine has it, so a person's windows survive a closed tab; else a login shell. */
export function defaultShell(): ShellPlan {
  return shellPlan(Bun.which("tmux") !== null, Bun.which("bash") !== null);
}

/**
 * The environment a machine shell starts with: the forge's own bun first on
 * PATH (the cell binds `/` read-only and reveals bun's directory even under a
 * hidden home, see `cellMounts`), then the forge's PATH, where git is.
 */
export function shellEnv(grant: ShellGrant, dir: string): Record<string, string> {
  return {
    PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    FORGE_REPO: `${grant.repo.ownerName}/${grant.repo.name}`,
    FORGE_CHECKOUT: join(dir, CHECKOUT_DIR),
    HOME: join(dir, "home"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    FORGE_MACHINE: grant.machine.name,
    FORGE_MACHINE_TOOLS: grant.machine.tools.join(" "),
  };
}

const sessions = new WeakMap<App, Map<string, Session>>();
const options = new WeakMap<App, ShellOptions>();
const handshakes = new WeakMap<App, Map<string, number[]>>();

export function setShellOptions(app: App, next: ShellOptions): void {
  options.set(app, next);
}

export function shellOptions(app: App): ShellOptions | undefined {
  return options.get(app);
}

function sessionsOf(app: App): Map<string, Session> {
  let map = sessions.get(app);
  if (map === undefined) {
    map = new Map();
    sessions.set(app, map);
  }
  return map;
}

/** The sessions running now. */
export function liveSessions(app: App): number {
  return sessionsOf(app).size;
}

const keyOf = (g: ShellGrant): string => `${g.repo.id}\0${g.machine.name}\0${g.user.id}`;

/**
 * Whether this handshake may go on: within the person's handshakes this
 * minute, and either joining their running session or within the caps.
 */
function roomFor(app: App, grant: ShellGrant, now = Date.now()): boolean {
  let byUser = handshakes.get(app);
  if (byUser === undefined) handshakes.set(app, (byUser = new Map()));
  const recent = (byUser.get(grant.user.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= (options.get(app)?.handshakesPerMinute ?? HANDSHAKES_PER_MINUTE)) return false;
  recent.push(now);
  byUser.set(grant.user.id, recent);
  const live = sessionsOf(app);
  if (live.has(keyOf(grant))) return true;
  if (live.size >= MAX_SESSIONS.forge) return false;
  let mine = 0;
  for (const s of live.values()) if (s.userId === grant.user.id) mine++;
  return mine < MAX_SESSIONS.person;
}

/** Each person's own directory on each machine: one writer's files and history are never the next's. */
export function workspace(app: App, repo: Repo, machine: Machine, userId: string): string {
  return join(app.config.dataDir, "machines", repo.id, machine.name, userId);
}

/**
 * The origins a shell's cell may open (#9934): the forge always, and the
 * repository's own production and previews only when the machine says
 * `apps`. `appUrls` are made from this repository's slug and pulls
 * (`crew/app_hosts.ts`), so another repository's app is never among them;
 * each is an exact host and port, never a pattern.
 */
export function shellReach(forgeUrl: string | undefined, machine: Machine, appUrls: readonly string[]): string[] {
  const forge = forgeUrl === undefined || forgeUrl === "" ? [] : [forgeUrl];
  return [...forge, ...reachableApps(machine, appUrls)];
}

/**
 * The cell a shell runs in: its own directory, the forge's data hidden, the
 * machine's ceilings, and the reach `shellReach` decides. Nothing the machine
 * says un-hides the forge's data.
 */
export function shellCell(
  app: App,
  dir: string,
  machine: Machine,
  label: string,
  appUrls: readonly string[] = [],
): CellSpec {
  const step = resolveLimits("step", undefined);
  return {
    dir,
    writable: [],
    home: join(dir, "home"),
    hide: cellHides(app),
    egress: [],
    reach: shellReach(app.config.url, machine, appUrls),
    limits: {
      ...step,
      memoryMiB: machine.memoryMiB ?? step.memoryMiB,
      cpus: machine.cpus ?? step.cpus,
    },
    terminal: true,
    label,
  };
}

/** The idle limit an admin set at `/admin/limits`, in ms; read at every check. */
export const shellIdleMs = (db: Database): number => limitValue(db, "shell_idle_minutes") * 60_000;

const idleLimit = (opts: ShellOptions): number => (typeof opts.idleMs === "function" ? opts.idleMs() : opts.idleMs);

/** Idle only when both the last keystroke and the last output are older than the limit. */
export function idle(session: { lastInput: number; lastOutput: number }, limitMs: number, now = Date.now()): boolean {
  return now - session.lastInput >= limitMs && now - session.lastOutput >= limitMs;
}

/** One live shell of a person's on a machine: attached while a connection is open, else detached and due to stop. */
export interface MachineState {
  readonly attached: boolean;
  /** When an idle session ends (ms since epoch): the later of the last keystroke and output, plus the idle limit. */
  readonly stopsAt: number;
}

/** "attached", or "detached, stops at HH:MM UTC unless you come back"; undefined when no shell is live. Both doors say it. */
export function stateLine(state: MachineState | undefined): string | undefined {
  if (state === undefined) return undefined;
  return state.attached ? "attached" : `detached, stops at ${scheduleClock(state.stopsAt)} UTC unless you come back`;
}

/** A person's live shells in one repository, by machine name; only theirs, never another person's. */
export function machineStates(app: App, repoId: string, userId: string): Map<string, MachineState> {
  const opts = options.get(app);
  const idleMs = opts === undefined ? shellIdleMs(app.db) : idleLimit(opts);
  const states = new Map<string, MachineState>();
  for (const s of sessionsOf(app).values()) {
    if (s.userId !== userId || s.repoId !== repoId || s.ended) continue;
    const row = app.db
      .query<{ machine: string }, [string]>("SELECT machine FROM machine_sessions WHERE id = ?")
      .get(s.row);
    if (row === null) continue;
    states.set(row.machine, { attached: s.peers.size > 0, stopsAt: Math.max(s.lastInput, s.lastOutput) + idleMs });
  }
  return states;
}

function end(app: App, session: Session, reason: EndReason): void {
  if (session.ended) return;
  session.ended = true;
  clearInterval(session.timer);
  sessionsOf(app).delete(session.key);
  recordEnd(app.db, session.row, reason);
  if (reason !== "exit") session.program.hangup();
  for (const peer of session.peers) if (peer.readyState === WebSocket.OPEN) peer.close(1000, ENDED[reason]);
  session.peers.clear();
}

/** Whether the session's owner may still hold it: active, and still a writer of the repository. */
function stillMay(app: App, session: Session): boolean {
  const user = getUserById(app.db, session.userId);
  const repo = getRepoById(app.db, session.repoId);
  return user !== undefined && repo !== undefined && isActive(user) && canWrite(app.db, repo, user);
}

function start(app: App, grant: ShellGrant, opts: ShellOptions, cols: number, rows: number): Session | undefined {
  const dir = workspace(app, grant.repo, grant.machine, grant.user.id);
  const peers = new Set<Peer>();
  let terminal: Bun.Terminal | undefined;
  let cell: Cell | undefined;
  let row: string | undefined;
  let live: Session | undefined;
  try {
    mkdirSync(join(dir, "home"), { recursive: true });
    prepareHome(join(dir, "home"), {
      repo: `${grant.repo.ownerName}/${grant.repo.name}`,
      machine: grant.machine.name,
      detaches: opts.detaches === true,
      checkout: existsSync(join(dir, CHECKOUT_DIR, ".git")),
      tty: grant.tty ?? null,
    });
    row = recordStart(app.db, grant.repo.id, grant.machine.name, grant.user.id);
    terminal = new Bun.Terminal({
      cols,
      rows,
      data: (_t, chunk) => {
        if (live !== undefined) live.lastOutput = Date.now();
        for (const peer of peers) {
          if (peer.readyState !== WebSocket.OPEN) continue;
          // A peer that is not reading is closed, never buffered without end.
          if (peer.sendBinary(chunk) === 0 || peer.getBufferedAmount() > MAX_BUFFERED_BYTES)
            peer.close(1008, "not reading");
        }
      },
    });
    if (opts.contain === "cell")
      cell = openCell(
        shellCell(
          app,
          dir,
          grant.machine,
          cellLabel(grant.repo.id, grant.machine.name, grant.user.id),
          ownAppUrls(ownApp(app, grant.repo)),
        ),
      );
    const env = shellEnv(grant, dir);
    const program = startTerminal(opts.command, { terminal, env, cwd: dir, cell });
    const term = terminal;
    const session: Session = {
      key: keyOf(grant),
      userId: grant.user.id,
      repoId: grant.repo.id,
      row,
      terminal: term,
      program,
      peers,
      size: { cols, rows },
      lastInput: Date.now(),
      lastOutput: Date.now(),
      ended: false,
      timer: setInterval(
        () => {
          if (idle(session, idleLimit(opts))) end(app, session, "idle");
          else if (!stillMay(app, session)) end(app, session, "revoked");
        },
        Math.max(10, Math.min(idleLimit(opts), opts.checkMs ?? CHECK_MS)),
      ),
    };
    void program.exited.then(() => {
      term.close();
      end(app, session, "exit");
    });
    live = session;
    sessionsOf(app).set(session.key, session);
    app.log.info("machine shell started", {
      repo: `${grant.repo.ownerName}/${grant.repo.name}`,
      machine: grant.machine.name,
      user: grant.user.username,
    });
    return session;
  } catch (error) {
    // Nothing half-made is left behind: the pty, the cell, and an open row.
    try {
      terminal?.close();
    } catch {
      /* already closed */
    }
    cell?.close();
    if (row !== undefined) recordEnd(app.db, row, "failed");
    app.log.warn("machine shell did not start", { machine: grant.machine.name, error: String(error) });
    return undefined;
  }
}

/** The label a shell's cell is watched under: one per person, so its counters are theirs alone. */
export const cellLabel = (repoId: string, machine: string, userId: string): string =>
  `machine:${repoId}/${machine}/${userId}`;

/** One shell a person holds or held: plain data for the account page and the `sessions` tool. */
export interface ShellRow {
  readonly id: string;
  /** A machine shell, or an app's terminal (#10549); an app row's `machine` is its environment. */
  readonly kind: "machine" | "app";
  /** `owner/name`. */
  readonly repository: string;
  readonly machine: string;
  readonly startedAt: string;
  /** Null when the shell has ended: its last keystroke is not kept. */
  readonly lastInputAt: string | null;
  readonly lastOutputAt: string | null;
  /** Connections attached now; 0 is detached. */
  readonly peers: number;
  /** Cores in use and resident MiB, null where the cell does not report them. */
  readonly cpuCores: number | null;
  readonly memoryMiB: number | null;
  readonly endedAt: string | null;
  readonly endReason: EndReason | null;
  /** The end in words, null while live. */
  readonly endedBecause: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The shells running now for one person, newest first. */
export function liveShells(app: App, userId: string): ShellRow[] {
  const counters = new Map(cellCounters().map((c) => [c.label, c]));
  const rows: ShellRow[] = [];
  for (const s of sessionsOf(app).values()) {
    if (s.userId !== userId) continue;
    const repo = getRepoById(app.db, s.repoId);
    const started = app.db
      .query<{ machine: string; started_at: string }, [string]>("SELECT machine, started_at FROM machine_sessions WHERE id = ?")
      .get(s.row);
    if (repo === undefined || started === null) continue;
    const counter = counters.get(cellLabel(s.repoId, started.machine, userId));
    rows.push({
      id: s.row,
      kind: "machine",
      repository: `${repo.ownerName}/${repo.name}`,
      machine: started.machine,
      startedAt: started.started_at,
      lastInputAt: iso(s.lastInput),
      lastOutputAt: iso(s.lastOutput),
      peers: s.peers.size,
      cpuCores: counter?.cores ?? null,
      memoryMiB: counter === undefined ? null : Math.round(counter.memoryBytes / 1048576),
      endedAt: null,
      endReason: null,
      endedBecause: null,
    });
  }
  for (const e of appTtysOf(app, userId))
    rows.push({
      id: e.id,
      kind: "app",
      repository: e.repository,
      machine: `${e.slug} · ${e.env}`,
      startedAt: iso(e.startedAt),
      lastInputAt: iso(e.lastInput),
      lastOutputAt: iso(e.lastOutput),
      peers: 0,
      cpuCores: null,
      memoryMiB: null,
      endedAt: null,
      endReason: null,
      endedBecause: null,
    });
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** How many ended shells `myShells` adds after the live ones. */
export const RECENT_ENDED = 10;

/** A person's shells: the live ones, newest first, then the last ended ones, newest first. */
export function myShells(app: App, userId: string, ended = RECENT_ENDED): ShellRow[] {
  const gone = app.db
    .query<
      { id: string; machine: string; started_at: string; ended_at: string; end_reason: EndReason; owner_name: string; name: string },
      [string, number]
    >(
      `SELECT s.id, s.machine, s.started_at, s.ended_at, s.end_reason, o.username AS owner_name, r.name
         FROM machine_sessions s JOIN repo r ON r.id = s.repo_id JOIN user o ON o.id = r.owner_id
        WHERE s.owner_id = ? AND s.ended_at IS NOT NULL ORDER BY s.started_at DESC LIMIT ?`,
    )
    .all(userId, ended)
    .map(
      (r): ShellRow => ({
        id: r.id,
        kind: "machine",
        repository: `${r.owner_name}/${r.name}`,
        machine: r.machine,
        startedAt: r.started_at,
        lastInputAt: null,
        lastOutputAt: null,
        peers: 0,
        cpuCores: null,
        memoryMiB: null,
        endedAt: r.ended_at,
        endReason: r.end_reason,
        endedBecause: ENDED[r.end_reason] ?? r.end_reason,
      }),
    );
  return [...liveShells(app, userId), ...gone];
}

/** Stop one shell a person holds, by its row id: false when they hold no such live shell (another person's is the same answer). */
export function stopShell(app: App, userId: string, id: string): boolean {
  if (stopAppTty(app, userId, id)) return true;
  for (const s of sessionsOf(app).values()) {
    if (s.userId !== userId || s.row !== id) continue;
    end(app, s, "stopped");
    return true;
  }
  return false;
}

/** Stop every shell of a person's that is detached and past half its idle limit; returns how many. */
export function stopIdleShells(app: App, userId: string, idleMs = shellIdleMs(app.db)): number {
  let n = 0;
  for (const s of [...sessionsOf(app).values()]) {
    if (s.userId !== userId || s.peers.size > 0 || !idle(s, idleMs / 2)) continue;
    end(app, s, "stopped");
    n++;
  }
  return n + stopIdleAppTtys(app, userId, idleMs);
}

/** The receipts, one line each; the page and the `sessions` tool say them in the same words. */
export const STOPPED_ONE = "Shell stopped.";
export const NO_SUCH_SHELL = "No such shell.";
export const stoppedIdleSays = (n: number): string =>
  n === 0 ? "No idle shell to stop." : `Stopped ${n} idle shell${n === 1 ? "" : "s"}.`;

/** End every session (the forge is stopping). */
export function stopShells(app: App): void {
  for (const session of [...sessionsOf(app).values()]) end(app, session, "stopped");
  stopAllAppTtys(app);
}

/** Whether a socket's data is a shell's, so the forge's one handler can tell. */
export function isShellSocket(data: unknown): data is ShellSocket {
  return typeof data === "object" && data !== null && "shell" in data;
}

export const shellWebSocket = {
  open(ws: Peer): void {
    const { app, user, sessionId } = ws.data.shell;
    const opts = options.get(app);
    if (opts === undefined || opts.contain === "refuse") {
      ws.close(1011, "this forge cannot hold a machine's shell");
      return;
    }
    const session = sessionsOf(app).get(keyOf(ws.data.shell)) ?? start(app, ws.data.shell, opts, 80, 24);
    if (session === undefined) {
      ws.close(1011, ENDED.failed);
      return;
    }
    session.peers.add(ws);
    ws.data.joined = session;
    ws.data.release = holdOpen(app.db, user.id, sessionId, () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1008, "this account was suspended");
    });
  },
  message(ws: Peer, message: string | Buffer): void {
    const session = ws.data.joined;
    if (session === undefined || session.ended) return;
    if (typeof message === "string") {
      const resize = parseControl(message);
      if (resize === undefined) {
        ws.close(1003, "a text frame is a resize");
        return;
      }
      const plan = resizePlan(session.size, resize, ws.data.sized !== true);
      ws.data.sized = true;
      session.size = resize;
      const apply = (size: PtySize): void => {
        if (!session.ended && !session.terminal.closed) session.terminal.resize(size.cols, size.rows);
      };
      const [first, ...rest] = plan;
      if (first !== undefined) apply(first);
      // A newer frame in the meantime is the size that stands; this one is dropped.
      if (rest.length > 0) setTimeout(() => session.size === resize && rest.forEach(apply), REDRAW_NUDGE_MS);
      return;
    }
    if (message.byteLength > MAX_INPUT_BYTES) {
      ws.close(1009, "a keystroke frame is at most 64 KiB");
      return;
    }
    session.lastInput = Date.now();
    if (session.terminal.closed) return;
    try {
      session.terminal.write(message);
    } catch {
      /* the program is gone; the keystroke has nowhere to go */
    }
  },
  close(ws: Peer): void {
    ws.data.release?.();
    const session = ws.data.joined;
    if (session === undefined) return;
    session.peers.delete(ws);
    // The session stays for the next connection until it is idle or exits —
    // unless its owner was suspended or may no longer write here.
    if (session.peers.size === 0 && !stillMay(ws.data.shell.app, session))
      end(ws.data.shell.app, session, "revoked");
  },
};

/** What the forge's one `websocket` handler carries: an app's proxied socket, or a shell's. */
export type ForgeSocket<A> = A | ShellSocket;

/** The forge's one `websocket` handler, with a shell's sockets taken first. */
export function withShells<A extends object>(inner: Bun.WebSocketHandler<A>): Bun.WebSocketHandler<ForgeSocket<A>> {
  type W = Bun.ServerWebSocket<ForgeSocket<A>>;
  const asApp = (ws: W) => ws as Bun.ServerWebSocket<A>;
  const asShell = (ws: W) => ws as Peer;
  return {
    ...(inner.maxPayloadLength !== undefined ? { maxPayloadLength: inner.maxPayloadLength } : {}),
    ...(inner.backpressureLimit !== undefined ? { backpressureLimit: inner.backpressureLimit } : {}),
    ...(inner.closeOnBackpressureLimit !== undefined ? { closeOnBackpressureLimit: inner.closeOnBackpressureLimit } : {}),
    ...(inner.idleTimeout !== undefined ? { idleTimeout: inner.idleTimeout } : {}),
    open(ws) {
      if (isShellSocket(ws.data)) return shellWebSocket.open(asShell(ws));
      return inner.open?.(asApp(ws));
    },
    message(ws, message) {
      if (isShellSocket(ws.data)) return shellWebSocket.message(asShell(ws), message);
      return inner.message(asApp(ws), message);
    },
    close(ws, code, reason) {
      if (isShellSocket(ws.data)) return shellWebSocket.close(asShell(ws));
      return inner.close?.(asApp(ws), code, reason);
    },
    drain(ws) {
      if (isShellSocket(ws.data)) return;
      return inner.drain?.(asApp(ws));
    },
  };
}
