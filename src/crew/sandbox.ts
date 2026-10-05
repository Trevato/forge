/**
 * What an agent's shell may touch. Claude Code sandboxes its Bash tool
 * (seatbelt on macOS, bubblewrap on Linux when installed); the forge hands
 * it the policy: the network is the forge and the package registry, and
 * nothing else; writes stay in the clone and the temp dir (the sandbox's
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
 * the wrap-up), and an agent created mid-invocation is denied from the next.
 *
 * Each run has its own temp directory (`tmpDir`, handed to Claude Code as
 * `CLAUDE_CODE_TMPDIR` and `TMPDIR`) under the agent's own `.t/`, never the machine's
 * shared `/tmp/claude-<uid>`, which holds every other session's files and
 * is denied; the agent's other runs' temp directories are denied too.
 */

import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { crewRoot } from "./workdir.ts";

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

/** The entries of `dir` as paths, but `keep`; nothing when it is not there. */
function others(dir: string, keep: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name !== keep)
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Where a run's temp directory lives: short, because Claude Code makes sockets in it. */
export function runTmpDir(dataDir: string, agentName: string, runId: string): string {
  return join(crewRoot(dataDir), agentName, ".t", runId.slice(-12));
}

export function sandboxPolicy(input: {
  dataDir: string;
  agentName: string;
  /** URLs the agent must reach: the forge, locally and publicly. */
  urls: readonly string[];
  /** Hosts the operator vouches for beyond the forge and the registry. */
  extraHosts?: readonly string[] | undefined;
  /** Whether the host can enforce it (`sandboxAvailable`); yes by default. */
  enforced?: boolean | undefined;
  /** The run this is for: it gets a temp directory of its own (`tmpDir`). */
  runId?: string | undefined;
}): SandboxPolicy {
  const hosts = new Set<string>([
    "127.0.0.1",
    "localhost",
    "registry.npmjs.org",
  ]);
  for (const url of input.urls) {
    try {
      hosts.add(new URL(url).hostname);
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
  const deny = [
    // Every entry but crew/: the index, the key, the repositories, the hook
    // sockets, the checks' and apps' trees, the looks, whatever comes next.
    ...others(data, "crew"),
    // Every agent but this one.
    ...others(crew, input.agentName),
    // This agent's other runs' temp directories.
    ...others(join(own, ".t"), tmpDir === undefined ? "" : basename(tmpDir)),
    // The machine's shared Claude Code temp directory: every other session's.
    join(tmpdir(), `claude-${process.getuid?.() ?? 0}`),
  ];
  const home = homedir();
  for (const secret of HOME_SECRETS) deny.push(join(home, secret));
  return {
    allowHosts: [...hosts],
    denyRead: deny,
    enforced: input.enforced ?? true,
    ...(tmpDir === undefined ? {} : { tmpDir }),
  };
}
