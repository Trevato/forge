/**
 * What an agent's shell may touch. Claude Code sandboxes its Bash tool
 * (seatbelt on macOS, bubblewrap on Linux when installed); the forge hands
 * it the policy: the network is the forge, the package registry and the
 * run's own repository's app — production and its open pulls' previews
 * (`crew/app_hosts.ts`) — and nothing else; writes stay in the clone and the temp dir (the sandbox's
 * own default); reads are refused for everything on this machine that is
 * not the agent's business — the forge's repositories, its index and key,
 * the other agents' clones, and the operator's own credentials.
 *
 * The data directory is an allow-list: every entry in it is denied but
 * `crew/`, and inside `crew/` every agent's directory but this agent's — so
 * something the forge starts keeping there tomorrow is denied without
 * anyone remembering to add it. A denied path denies everything under it,
 * the working directory included, which is why `crew/` itself is not denied
 * and its entries are listed one by one. Claude Code cannot deny by rule,
 * so the list is taken again for every invocation of a run (the work and
 * the wrap-up): an entry created during an invocation — a new agent, a new
 * top-level directory — stays readable until the next one. A listing that
 * fails refuses the run (`SandboxListingError`) rather than deny nothing,
 * and the paths that must never be read are denied by name as well, so the
 * allow-list only ever adds to them.
 *
 * Each run has its own temp directory (`tmpDir`, handed to Claude Code as
 * `CLAUDE_CODE_TMPDIR` and `TMPDIR`) under the agent's own `.t/`; the
 * machine's temp directory, which holds every other session's files and
 * the forge's own, is denied whole, and so are the agent's other runs'
 * temp directories. The shell also writes bun's install cache, one per
 * repository under `crew/.cache/<repo id>/bun`: the runs on a repository
 * share it, and the other repositories' caches are denied. A run that ends
 * removes its own; what a forge that died left behind is swept at the next
 * crew start (`sweepRunTmp`).
 */

import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { cacheRoot, crewRoot, installCacheDir } from "./workdir.ts";

export interface SandboxPolicy {
  /** Hostnames the shell may connect to. */
  readonly allowHosts: readonly string[];
  /** Paths the shell may not read (and so not write). */
  readonly denyRead: readonly string[];
  /**
   * Whether the host can hold the shell to this. Where it cannot, the
   * policy is handed over switched off rather than left to fail: a run
   * that says "unsandboxed" is honest; one that warns on every command
   * and then runs anyway is not.
   */
  readonly enforced: boolean;
  /** This run's own temp directory, when the policy was asked for a run. */
  readonly tmpDir?: string | undefined;
  /**
   * The one place besides the clone and the temp directory the shell may
   * write: its repository's install cache, shared by every run on it.
   */
  readonly installCache?: string | undefined;
  /** Paths re-allowed within `denyRead`: this run's own repository's cache. */
  readonly readAllow: readonly string[];
}

/**
 * The one directory under the run's temp directory the sandboxed shell may
 * write, and the `TMPDIR` it re-exports: `<tmpDir>/claude-<uid>`.
 */
export function shellTmpDir(policy: SandboxPolicy): string | undefined {
  return policy.tmpDir === undefined
    ? undefined
    : join(policy.tmpDir, `claude-${process.getuid?.() ?? 0}`);
}

/**
 * The run's env for its repository's install cache: the directory made, and
 * bun told to use it. A policy with no cache (no repository) changes nothing.
 */
export function installCacheEnv(
  policy: SandboxPolicy,
  env: Record<string, string>,
): void {
  // Bun reads BUN_TMPDIR before TMPDIR. The run's temp directory is read-only
  // to the shell; only `shellTmpDir` under it is writable.
  const tmp = shellTmpDir(policy);
  if (tmp !== undefined) {
    mkdirSync(tmp, { recursive: true });
    env["BUN_TMPDIR"] = tmp;
  }
  if (policy.installCache === undefined) return;
  mkdirSync(policy.installCache, { recursive: true });
  env["BUN_INSTALL_CACHE_DIR"] = policy.installCache;
}

/**
 * Whether Claude Code's sandbox can work here. macOS has one built in;
 * Linux needs bubblewrap and socat on `PATH`, and a kernel and seccomp
 * profile that let an unprivileged process make a user namespace — which a
 * locked-down container usually does not. Probed once, at crew start.
 */
export async function sandboxAvailable(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  if (process.platform === "darwin") return { ok: true };
  if (process.platform !== "linux")
    return { ok: false, reason: `no sandbox on ${process.platform}` };
  for (const tool of ["bwrap", "socat"])
    if (Bun.which(tool) === null)
      return { ok: false, reason: `${tool} is not installed` };
  try {
    const proc = Bun.spawn(
      ["bwrap", "--unshare-user", "--ro-bind", "/", "/", "--", "/bin/true"],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    const [err, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code === 0) return { ok: true };
    const line = err.trim().split("\n").pop() ?? "";
    return {
      ok: false,
      reason: `user namespaces are refused here${line === "" ? "" : ` (${line})`}`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The operator's own secrets, wherever they usually are. */
const HOME_SECRETS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".netrc",
  ".npmrc",
  ".docker",
  ".kube",
  ".config/gh",
  ".claude",
  ".claude.json",
];

/** The data directory could not be listed: the run is refused, never left undenied. */
export class SandboxListingError extends Error {}

/**
 * The entries of `dir` as paths, but `keep`. A directory that is not there
 * has nothing in it; one that cannot be listed (too many open files, a
 * permission) throws, because an empty answer would deny nothing.
 */
function others(dir: string, keep: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name !== keep)
      .map((name) => join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SandboxListingError(
      `cannot list ${dir} to build the shell's sandbox: ${(error as Error).message}`,
    );
  }
}

/**
 * The machine's temp directory, whole. When the data directory lives inside
 * it (a developer's forge, a test) the whole cannot be denied, and listing
 * every entry of a busy temp directory overflows Claude Code's argument
 * list; there the forge's own pieces are denied instead: the shared Claude
 * Code directory and the cells' socket directories (`apps/contain.ts`).
 */
/** Whether the forge's data directory lives inside the machine's temp directory. */
export function dataInTemp(data: string): boolean {
  return inside(tmpdir(), data);
}

function tempDenied(data: string, tmpDir: string | undefined): string[] {
  const temp = tmpdir();
  const own = tmpDir !== undefined && !inside(data, tmpDir) && inside(temp, tmpDir) ? basename(tmpDir) : undefined;
  if (!dataInTemp(data)) {
    // The run's own temp directory is in it (`runTmpDir`): everything else there is denied.
    return own === undefined ? [temp] : others(temp, own);
  }
  // The data directory is in it too, so listing the whole would deny the
  // agent's own crew directory with it (a check's long temp, #10541): the
  // forge's own pieces are denied by name, and every other run's temp.
  return [
    join(temp, `claude-${process.getuid?.() ?? 0}`),
    ...others(temp, "").filter((path) => {
      const name = basename(path);
      return name.startsWith("fc-") || (name.startsWith(RUN_TMP_PREFIX) && name !== own);
    }),
  ];
}

/** Denied by name whatever the listing says: what must never be read. */
const ALWAYS_DENIED = [
  "repos",
  "forge.db",
  "forge.db-wal",
  "forge.db-shm",
  "secret.key",
  "ssh",
  "apps",
  "runs",
  "checks",
  "looks",
  "egress",
];

/**
 * Remove the run temp directories older than `olderThanMs` that a forge
 * which stopped mid-run left behind. Only old ones: during a rollout the
 * forge being replaced is still finishing its runs beside this one.
 */
export function sweepRunTmp(dataDir: string, olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  let swept = 0;
  for (const agent of others(crewRoot(dataDir), "")) {
    for (const dir of others(join(agent, ".t"), "")) {
      try {
        if (statSync(dir).mtimeMs > cutoff) continue;
        rmSync(dir, { recursive: true, force: true });
        swept++;
      } catch {
        // gone already
      }
    }
  }
  for (const dir of others(tmpdir(), "").filter((path) => basename(path).startsWith(RUN_TMP_PREFIX))) {
    try {
      if (statSync(dir).mtimeMs > cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      swept++;
    } catch {
      // gone already
    }
  }
  return swept;
}

/** What a socket name takes in the run's temp directory: `/claude-socks-<16 hex>.sock`, with room to spare. */
const SOCKET_NAME_ROOM = 40;
/** The longest path a unix socket may have on Linux (`sun_path`, less its NUL). */
const SOCKET_PATH_MAX = 107;

/**
 * Where a run's temp directory lives: under the agent, unless that leaves
 * Claude Code's bridge sockets too long a path to bind. A child forge's data
 * sits under `children/cell-<uuid>`, so there it is the machine's temp
 * directory instead (in a cell, the cell's own `/tmp`). scottishbob,
 * 2026-11-10: every Bash call failed "Failed to create bridge sockets after
 * 5 attempts" at a 124-character socket path.
 */
export function runTmpDir(
  dataDir: string,
  agentName: string,
  runId: string,
  host: { readonly linux: boolean; readonly temp: string } = { linux: process.platform === "linux", temp: tmpdir() },
): string {
  const own = join(crewRoot(dataDir), agentName, ".t", runId.slice(-12));
  if (!host.linux || own.length + SOCKET_NAME_ROOM <= SOCKET_PATH_MAX) return own;
  return join(host.temp, `${RUN_TMP_PREFIX}${runId.slice(-12)}`);
}

/** A run temp directory in the machine's temp directory (`runTmpDir`) starts so. */
const RUN_TMP_PREFIX = "fr-";

/** Whether `path` is inside `dir`. */
function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function sandboxPolicy(input: {
  dataDir: string;
  agentName: string;
  /** URLs the agent must reach: the forge, locally and publicly. */
  urls: readonly string[];
  /**
   * The run's own repository's app URLs (`crew/app_hosts.ts`). Allowed by
   * host and port together: an app domain of `localhost` resolves to
   * loopback, and a bare `notes.localhost` would be every local port.
   */
  appUrls?: readonly string[] | undefined;
  /** Hosts the operator vouches for beyond the forge and the registry. */
  extraHosts?: readonly string[] | undefined;
  /** Whether the host can enforce it (`sandboxAvailable`); yes by default. */
  enforced?: boolean | undefined;
  /** The run this is for: it gets a temp directory of its own (`tmpDir`). */
  runId?: string | undefined;
  /** The repository the run is on: its install cache is writable (`installCache`). */
  repoId?: string | undefined;
}): SandboxPolicy {
  const hosts = new Set<string>(["registry.npmjs.org"]);
  for (const url of input.urls) {
    try {
      const parsed = new URL(url);
      // Loopback is allowed by port, never whole: the proxy reaches outside
      // the sandbox, so a bare 127.0.0.1 would be every local service.
      hosts.add(
        LOOPBACK.has(parsed.hostname) && parsed.port !== ""
          ? parsed.host
          : parsed.hostname,
      );
    } catch {
      // Not a URL: nothing to allow.
    }
  }
  for (const url of input.appUrls ?? []) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      // Not a URL: nothing to allow.
    }
  }
  for (const host of input.extraHosts ?? [])
    if (host.trim() !== "") hosts.add(host.trim());

  const data = input.dataDir;
  const crew = crewRoot(data);
  const own = join(crew, input.agentName);
  const tmpDir =
    input.runId === undefined
      ? undefined
      : runTmpDir(data, input.agentName, input.runId);
  const installCache =
    input.repoId === undefined
      ? undefined
      : installCacheDir(data, input.repoId);
  const deny = [
    // The floor: named, whether or not the listing below sees them.
    ...ALWAYS_DENIED.map((name) => join(data, name)),
    // Every entry but crew/: the index, the key, the repositories, the hook
    // sockets, the checks' and apps' trees, the looks, whatever comes next.
    ...others(data, "crew"),
    // Every agent but this one.
    ...others(crew, input.agentName),
    // The mirrors, by name: one a later run creates is not in the listing.
    join(crew, ".mirrors"),
    // This agent's other runs' temp directories.
    ...others(join(own, ".t"), tmpDir === undefined ? "" : basename(tmpDir)),
    // The machine's temp directory: every other session's files, and the
    // forge's own (a cell's sockets, a checkout's index).
    ...tempDenied(data, tmpDir),
    // Every repository's install cache, whole and not listed: one created
    // after this policy was built is denied too. This run's own is
    // re-allowed (`readAllow`) and written (`allowWrite`).
    cacheRoot(data),
  ];
  const home = homedir();
  for (const secret of HOME_SECRETS) deny.push(join(home, secret));
  return {
    allowHosts: [...hosts],
    denyRead: deny,
    enforced: input.enforced ?? true,
    readAllow: installCache === undefined ? [] : [installCache],
    ...(tmpDir === undefined ? {} : { tmpDir }),
    ...(installCache === undefined ? {} : { installCache }),
  };
}
