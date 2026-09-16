/**
 * What an agent's shell may touch. Claude Code sandboxes its Bash tool
 * (seatbelt on macOS, bubblewrap on Linux when installed); the forge hands
 * it the policy: the network is the forge and the package registry, and
 * nothing else; writes stay in the clone and the temp dir (the sandbox's
 * own default); reads are refused for everything on this machine that is
 * not the agent's business — the forge's repositories, its index and key,
 * the other agents' clones, and the operator's own credentials.
 *
 * A denied path denies everything under it, the working directory
 * included, which is why the crew root is not simply denied: the other
 * agents' directories are listed one by one at the moment the run starts.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
];

const SOCKET_FILE = /^forge(?:-[a-z0-9]+)?\.sock$/;

function socketsIn(data: string): string[] {
  try {
    return readdirSync(data)
      .filter((name) => SOCKET_FILE.test(name))
      .map((name) => join(data, name));
  } catch {
    return [join(data, "forge.sock")];
  }
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
  const deny = [
    join(data, "repos"),
    join(data, "forge.db"),
    join(data, "forge.db-wal"),
    join(data, "forge.db-shm"),
    join(data, "secret.key"),
    // Every forge's hook socket in the directory: this one's, and an old
    // one's still draining beside it. A hook's authority is the forge's.
    ...socketsIn(data),
    join(data, "ssh"),
    join(data, "apps"),
    join(data, "runs"),
  ];
  const crew = crewRoot(data);
  if (existsSync(crew)) {
    for (const name of readdirSync(crew)) {
      if (name !== input.agentName) deny.push(join(crew, name));
    }
  }
  const home = homedir();
  for (const secret of HOME_SECRETS) deny.push(join(home, secret));
  return {
    allowHosts: [...hosts],
    denyRead: deny,
    enforced: input.enforced ?? true,
  };
}
