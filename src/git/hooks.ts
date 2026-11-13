/**
 * Server-side hooks: the bridge that keeps the index consistent with git.
 * The stub installed into each bare repo re-enters the forge itself in
 * "hook" mode — so it works identically whether the forge runs via
 * `bun run` or as a compiled single-file binary, and can never point at a
 * script file that has moved or been bundled away. Every moving part
 * (runtime, entry, socket, identity) arrives via environment the forge sets
 * when it spawns receive-pack, so the stubs never go stale.
 */

import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { fetchInternal } from "./hook-address.ts";
import {
  FORWARDED_GIT_ENV,
  HOOK_SECRET_HEADER,
  parseHookStdin,
} from "./hook-protocol.ts";

const HOOK_NAMES = ["pre-receive", "post-receive"] as const;
type HookName = (typeof HOOK_NAMES)[number];

// FORGE_ENTRY is set (dev) or unset (compiled binary); both branches are
// fully quoted, so install paths with spaces are safe.
const stub = (name: HookName) => `#!/bin/sh
# installed by forge — do not edit; all configuration arrives via environment
if [ -n "\${FORGE_ENTRY:-}" ]; then
  exec "$FORGE_RUNTIME" "$FORGE_ENTRY" hook ${name}
else
  exec "$FORGE_RUNTIME" hook ${name}
fi
`;

export async function installHooks(bareDir: string): Promise<void> {
  for (const name of HOOK_NAMES) {
    const path = join(bareDir, "hooks", name);
    await Bun.write(path, stub(name));
    await chmod(path, 0o755);
  }
}

/**
 * How to re-invoke the hook client. A compiled binary has no on-disk script,
 * so it re-enters itself via the `hook` subcommand (dispatched in main.ts);
 * otherwise it runs the dedicated hook entry file, which self-dispatches no
 * matter what launched the host process (`bun run`, `bun test`, embedding).
 */
function selfInvocation(): { runtime: string; entry: string | undefined } {
  const compiled = Bun.main.startsWith("/$bunfs/");
  if (compiled) return { runtime: process.execPath, entry: undefined };
  return {
    runtime: process.execPath,
    entry: join(import.meta.dir, "hook-entry.ts"),
  };
}

/** Env for a receive-pack spawn so its hooks can reach back into the forge. */
export function hookEnv(input: {
  socketPath: string;
  secret: string;
  repoId: string;
  actorId: string;
  /** Set for a proposal token: the one namespace its push may touch. */
  proposalChild?: string;
  /** Set for an outside agent's contribute token: the one namespace its push may touch. */
  contribAgent?: string;
  /** The address the pusher reached the forge at: a contribute push prints URLs on it. */
  pushOrigin?: string;
}): Record<string, string> {
  const self = selfInvocation();
  const env: Record<string, string> = {
    FORGE_RUNTIME: self.runtime,
    FORGE_SOCKET: input.socketPath,
    FORGE_HOOK_SECRET: input.secret,
    FORGE_REPO_ID: input.repoId,
    FORGE_ACTOR_ID: input.actorId,
  };
  if (input.proposalChild !== undefined)
    env.FORGE_PROPOSAL_CHILD = input.proposalChild;
  if (input.contribAgent !== undefined) env.FORGE_CONTRIB_AGENT = input.contribAgent;
  if (input.pushOrigin !== undefined) env.FORGE_PUSH_ORIGIN = input.pushOrigin;
  if (self.entry !== undefined) env.FORGE_ENTRY = self.entry;
  return env;
}

export function isHookName(value: string | undefined): value is HookName {
  return value === "pre-receive" || value === "post-receive";
}

/**
 * The hook body, run inside a push. Relays stdin and the quarantine env to
 * the forge over its unix socket and exits with the forge's verdict. Kept
 * tiny: every line here runs inside every push and can fail one.
 *
 * Exit contract: 0 accepts, 1 rejects (pre-receive); the response body is
 * shown to the pusher verbatim. Never returns.
 */
/** How long the hook waits on the forge before it gives up. */
export const HOOK_RELAY_TIMEOUT_MS = 120_000;

export async function runHookClient(hook: HookName): Promise<never> {
  const socket = process.env.FORGE_SOCKET;
  if (!socket) {
    // Hook stderr is shown to the pusher by git; it must be stderr.
    console.error("forge hook: FORGE_SOCKET unset");
    process.exit(1);
  }

  const stdin = await new Response(Bun.stdin.stream()).text();
  const gitEnv: Record<string, string> = {};
  for (const name of FORWARDED_GIT_ENV) {
    const value = process.env[name];
    if (value !== undefined) gitEnv[name] = value;
  }

  try {
    const response = await fetchInternal(socket, "/internal/hook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HOOK_SECRET_HEADER]: process.env.FORGE_HOOK_SECRET ?? "",
      },
      // A forge that has stopped answering must not become a push that never
      // returns. Without a deadline this relay waits forever, and the git
      // process holding the repo's ref lock waits with it — one wedged forge
      // turning into a repository nobody can push to. Generous, because a
      // pre-receive legitimately talks to an origin before it answers.
      signal: AbortSignal.timeout(HOOK_RELAY_TIMEOUT_MS),
      body: JSON.stringify({
        hook,
        repoId: process.env.FORGE_REPO_ID ?? "",
        actorId: process.env.FORGE_ACTOR_ID ?? "",
        ...(process.env.FORGE_PROPOSAL_CHILD !== undefined
          ? { proposalChild: process.env.FORGE_PROPOSAL_CHILD }
          : {}),
        ...(process.env.FORGE_CONTRIB_AGENT !== undefined
          ? { contribAgent: process.env.FORGE_CONTRIB_AGENT }
          : {}),
        ...(process.env.FORGE_PUSH_ORIGIN !== undefined ? { pushOrigin: process.env.FORGE_PUSH_ORIGIN } : {}),
        updates: parseHookStdin(stdin),
        gitEnv,
      }),
    });
    const text = await response.text();
    // The relayed refusal text, for the pusher to read.
    if (text !== "") console.error(text);
    process.exit(response.ok ? 0 : 1);
  } catch (error) {
    // pre-receive fails closed: an unreachable forge must not admit a push.
    // Hook stderr is shown to the pusher by git.
    console.error(`forge: hook relay failed (${String(error)})`);
    process.exit(hook === "pre-receive" ? 1 : 0);
  }
}

export { ZERO_OID, type HookRequest, type RefUpdate } from "./hook-protocol.ts";
