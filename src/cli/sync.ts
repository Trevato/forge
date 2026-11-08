/**
 * Keeping the repos you care about on your machine, fresh.
 *
 * The model is deliberately small: the workbench says which repos you want
 * (pins), the client makes sure each one exists under
 * `<root>/<host>/<owner>/<name>` and has been fetched, and then it *reports*.
 * It never merges, rebases, resets or checks anything out on its own — the
 * one exception is `--ff`, which fast-forwards a clean repo only after
 * `merge-base --is-ancestor` has proved that fast-forwarding is all it is.
 *
 * A sync that could lose work is a sync nobody runs on a schedule.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as git from "../git/local.ts";
import { hostDir } from "./config.ts";
import { tokenGitEnv, type ForgeApi, type Pin } from "./api.ts";

export interface RepoReport {
  readonly owner: string;
  readonly name: string;
  readonly dir: string;
  /** The repo exists on disk (it may have been cloned this run). */
  readonly present: boolean;
  readonly cloned: boolean;
  /** Still listed in the pins (false = on disk but no longer wanted). */
  readonly pinned: boolean;
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: number;
  readonly changed: number;
  readonly untracked: number;
  readonly conflicted: number;
  readonly stashes: number;
  /** Local branches with no upstream, or ahead of the one they have. */
  readonly unpushed: string[];
  readonly lastFetch: Date | null;
  readonly fastForwarded: boolean;
  readonly error: string | null;
  /** Why git ran without the token, in one line; absent when it had it. */
  readonly note?: string;
}

export interface SyncReport {
  readonly root: string;
  readonly repos: RepoReport[];
  /** The forge has no pins endpoint; every repo you own was used instead. */
  readonly pinsUnavailable: boolean;
  readonly failures: number;
}

export interface SyncOptions {
  readonly api: ForgeApi;
  readonly token: string;
  /** The library root — the host directory is added below it. */
  readonly root: string;
  /** false for `forge status`: report what is on disk, touch the network. */
  readonly fetch: boolean;
  readonly ff?: boolean;
  readonly concurrency?: number;
  readonly onProgress?: (repo: string, text: string) => void;
}

export function isDirty(r: RepoReport): boolean {
  return r.staged + r.changed + r.untracked + r.conflicted > 0;
}

/**
 * One pass. Pins are fetched first (so a repo pinned five seconds ago is
 * cloned in this pass), then every repo is visited with a bounded number in
 * flight — a laptop on hotel wifi with forty pins must not open forty
 * connections.
 */
export async function syncOnce(opts: SyncOptions): Promise<SyncReport> {
  const host = hostDir(opts.api.url);
  const root = join(opts.root, host);
  await mkdir(root, { recursive: true });

  const pins = await opts.api.pins();
  const wanted = pins.ok ? pins.value : [];
  const pinError = pins.ok ? null : pins.error.message;

  const byPath = new Map<string, Pin | null>();
  for (const pin of wanted) byPath.set(`${pin.owner}/${pin.name}`, pin);
  // Repos already on disk that are no longer pinned are still reported: they
  // are your work, and silently ignoring them is how a client loses a commit.
  for (const found of await scanLocal(root))
    if (!byPath.has(found)) byPath.set(found, null);

  const entries = [...byPath.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const reports = await pool(
    entries,
    opts.concurrency ?? 4,
    async ([key, pin]) => {
      const [owner = "", name = ""] = key.split("/");
      return visit(root, owner, name, pin, opts);
    },
  );

  return {
    root,
    repos: reports,
    pinsUnavailable: opts.api.pinsUnavailable,
    failures:
      reports.filter((r) => r.error !== null).length +
      (pinError === null ? 0 : 1),
  };
}

/** Clone one repo into the same place a sync would, and report it. */
export async function cloneOne(
  pin: Pin,
  opts: Omit<SyncOptions, "fetch">,
): Promise<RepoReport> {
  const root = join(opts.root, hostDir(opts.api.url));
  await mkdir(root, { recursive: true });
  return visit(root, pin.owner, pin.name, pin, { ...opts, fetch: true });
}

/** Every `<owner>/<name>` git repo under the host directory. */
export async function scanLocal(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const owner of await dirs(root))
    for (const name of await dirs(join(root, owner)))
      if (await Bun.file(join(root, owner, name, ".git/HEAD")).exists())
        out.push(`${owner}/${name}`);
  return out.sort();
}

async function dirs(path: string): Promise<string[]> {
  try {
    const found = await readdir(path, { withFileTypes: true });
    return found
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function visit(
  root: string,
  owner: string,
  name: string,
  pin: Pin | null,
  opts: SyncOptions,
): Promise<RepoReport> {
  const dir = join(root, owner, name);
  const label = `${owner}/${name}`;
  const progress = (text: string): void => opts.onProgress?.(label, text);
  let cloned = false;
  let error: string | null = null;
  let note: string | undefined;
  const withheld = (why: string): void => {
    note = why;
    progress(why);
  };

  const exists = await Bun.file(join(dir, ".git/HEAD")).exists();
  if (!exists) {
    if (pin === null || !opts.fetch)
      return absent(owner, name, dir, pin !== null);
    await mkdir(join(root, owner), { recursive: true });
    const url = await remoteFor(pin);
    const why = url.ssh ? null : tokenRefusal(url.url, opts.api.url);
    if (why !== null) withheld(why);
    const result = await git.clone(url.url, dir, {
      parent: join(root, owner),
      onProgress: progress,
      ...(url.ssh || why !== null ? {} : { env: tokenGitEnv(opts.token) }),
    });
    if (!result.ok)
      return {
        ...absent(owner, name, dir, true),
        error: result.error.stderr,
        ...(note === undefined ? {} : { note }),
      };
    cloned = true;
    if (pin.origin !== null)
      await git.setRemote(dir, "upstream", pin.origin.htmlUrl);
  } else if (opts.fetch) {
    const url = await git.remoteUrl(dir);
    const ssh = url !== null && !url.startsWith("http");
    const why = ssh ? null : tokenRefusal(url, opts.api.url);
    if (why !== null) withheld(why);
    const result = await git.fetch(dir, {
      onProgress: progress,
      ...(ssh || why !== null ? {} : { env: tokenGitEnv(opts.token) }),
    });
    if (!result.ok) error = result.error.stderr;
  }

  const state = await inspect(dir);
  let fastForwarded = false;
  // Every condition is required, and the last one is the proof: HEAD must
  // already be an ancestor of the upstream, so "merge" can only mean moving
  // a pointer forward. Clean tree, nothing of our own ahead, nothing
  // half-finished — and only then.
  if (
    opts.ff === true &&
    error === null &&
    state.branch !== null &&
    state.upstream !== null &&
    state.behind > 0 &&
    state.ahead === 0 &&
    state.staged + state.changed + state.untracked + state.conflicted === 0 &&
    (await git.sequence(dir)) === "none" &&
    (await git.isAncestor(dir, "HEAD", state.upstream))
  ) {
    const merged = await git.mergeBranch(dir, state.upstream, { ffOnly: true });
    if (merged.ok) fastForwarded = true;
    else error = merged.error.stderr;
  }

  const after = fastForwarded ? await inspect(dir) : state;
  return {
    owner,
    name,
    dir,
    present: true,
    cloned,
    pinned: pin !== null,
    fastForwarded,
    error,
    ...(note === undefined ? {} : { note }),
    ...after,
  };
}

type Inspected = Omit<
  RepoReport,
  | "owner"
  | "name"
  | "dir"
  | "present"
  | "cloned"
  | "pinned"
  | "fastForwarded"
  | "error"
>;

async function inspect(dir: string): Promise<Inspected> {
  const status = await git.status(dir);
  const stashes = await git.stashList(dir);
  const local = await git.branches(dir);
  const unpushed = local.ok
    ? local.value
        .filter((b) => b.upstream === null || b.ahead > 0)
        .map((b) => b.name)
    : [];
  if (!status.ok)
    return {
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      changed: 0,
      untracked: 0,
      conflicted: 0,
      stashes: stashes.ok ? stashes.value.length : 0,
      unpushed,
      lastFetch: await git.lastFetch(dir),
    };
  const s = status.value;
  return {
    branch: s.head,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    staged: s.staged.length,
    changed: s.unstaged.length,
    untracked: s.untracked.length,
    conflicted: s.conflicted.length,
    stashes: stashes.ok ? stashes.value.length : 0,
    unpushed,
    lastFetch: await git.lastFetch(dir),
  };
}

function absent(
  owner: string,
  name: string,
  dir: string,
  pinned: boolean,
): RepoReport {
  return {
    owner,
    name,
    dir,
    present: false,
    cloned: false,
    pinned,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    changed: 0,
    untracked: 0,
    conflicted: 0,
    stashes: 0,
    unpushed: [],
    lastFetch: null,
    fastForwarded: false,
    error: null,
  };
}

/**
 * Why the token must not go to this git URL, or null when it may: the URL has
 * the workbench's own origin (scheme, host, port), and is https or plain http
 * to loopback. An edited `origin` must not be able to collect the token.
 */
export function tokenRefusal(
  remote: string | null,
  workbench: string,
): string | null {
  const refuse = (what: string): string =>
    `token withheld: origin ${what} is not this workbench over https`;
  if (remote === null) return refuse("(unreadable)");
  let r: URL;
  let w: URL;
  try {
    r = new URL(remote);
    w = new URL(workbench);
  } catch {
    return refuse("(unparseable)");
  }
  if (r.origin !== w.origin) return refuse(r.origin);
  if (r.protocol === "https:") return null;
  const loopback =
    r.hostname === "localhost" ||
    r.hostname === "[::1]" ||
    /^127\./.test(r.hostname);
  return r.protocol === "http:" && loopback ? null : refuse(r.origin);
}

/**
 * SSH when the user has a key and the forge offered an `ssh://` URL: their
 * agent and `~/.ssh/config` then do the authentication, and no token ever
 * touches the remote. Otherwise HTTPS, with the token supplied per-process
 * through git config — never written into the stored remote URL, where every
 * `git remote -v` would print it.
 */
async function remoteFor(pin: Pin): Promise<{ url: string; ssh: boolean }> {
  if (pin.sshUrl !== null && (await hasSshKey()))
    return { url: pin.sshUrl, ssh: true };
  return { url: pin.cloneUrl, ssh: false };
}

let sshKeyCache: boolean | undefined;

async function hasSshKey(): Promise<boolean> {
  if (sshKeyCache !== undefined) return sshKeyCache;
  const home = process.env["HOME"];
  if (home === undefined) return (sshKeyCache = false);
  const names = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];
  for (const name of names)
    if (await Bun.file(join(home, ".ssh", name)).exists())
      return (sshKeyCache = true);
  return (sshKeyCache = false);
}

/** Run `work` over `items` with at most `limit` in flight, order preserved. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (item === undefined) return;
        out[i] = await work(item);
      }
    },
  );
  await Promise.all(runners);
  return out;
}

// ── change detection ─────────────────────────────────────────────────────

/**
 * What `--watch` may interrupt someone for. A notification on every tick is
 * a notification that gets muted, so only genuine transitions count: new
 * commits arriving, a repo appearing or disappearing, and a fetch that
 * started failing (never one that is still failing).
 */
export function changesBetween(
  before: SyncReport | null,
  after: SyncReport,
): string[] {
  if (before === null) return [];
  const was = new Map(before.repos.map((r) => [`${r.owner}/${r.name}`, r]));
  const changes: string[] = [];
  for (const now of after.repos) {
    const key = `${now.owner}/${now.name}`;
    const then = was.get(key);
    if (then === undefined) {
      if (now.pinned) changes.push(`${key} is new`);
      continue;
    }
    if (now.behind > then.behind)
      changes.push(`${key} is ${now.behind} behind`);
    if (now.error !== null && then.error === null)
      changes.push(`${key} failed to fetch`);
    if (!now.present && then.present) changes.push(`${key} is gone`);
  }
  return changes;
}
