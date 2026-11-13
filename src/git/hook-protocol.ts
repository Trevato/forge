/**
 * Pure hook wire-format: the shapes and parsing shared by the hook client
 * (running inside a push) and the forge's socket handler. No side effects,
 * no spawns — safe to import from anywhere without dragging in runtime.
 */

/** One ref update as reported on a hook's stdin: "<old> <new> <ref>". */
export interface RefUpdate {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface HookRequest {
  readonly hook: "pre-receive" | "post-receive";
  readonly repoId: string;
  readonly actorId: string;
  /** A proposal token's child: every ref must be inside `child/<name>/`. */
  readonly proposalChild?: string;
  /** An outside agent's name: every ref must be inside `contrib/<agent>/`. */
  readonly contribAgent?: string;
  /** The forge's address as the pusher reached it, for the URLs a push prints. */
  readonly pushOrigin?: string;
  readonly updates: readonly RefUpdate[];
  /**
   * Quarantine environment forwarded from the hook process. Any git command
   * evaluating not-yet-accepted objects (ancestry checks in pre-receive)
   * must run with these, or the new objects are invisible to it.
   */
  readonly gitEnv: Record<string, string>;
}

/** The header that carries the per-boot secret to the internal listener. */
export const HOOK_SECRET_HEADER = "x-forge-hook-secret";

export const FORWARDED_GIT_ENV = [
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
] as const;

/** Only the quarantine variables a hook may forward reach git. */
export function forwardedGitEnv(env: unknown): Record<string, string> {
  const kept: Record<string, string> = {};
  if (typeof env !== "object" || env === null) return kept;
  for (const name of FORWARDED_GIT_ENV) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string") kept[name] = value;
  }
  return kept;
}

export function parseHookStdin(text: string): RefUpdate[] {
  const updates: RefUpdate[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    // Exactly two splits: git hands the hook a ref name it has not yet
    // validated, and one carrying a space must arrive whole so the safety
    // checks refuse it as itself — split on every space and "refs/heads/sp
    // ace" would become the perfectly legal, entirely different
    // "refs/heads/sp" and travel upstream under that name.
    const first = line.indexOf(" ");
    const second = first < 0 ? -1 : line.indexOf(" ", first + 1);
    if (first <= 0 || second <= first + 1 || second === line.length - 1)
      continue;
    updates.push({
      oldOid: line.slice(0, first),
      newOid: line.slice(first + 1, second),
      ref: line.slice(second + 1),
    });
  }
  return updates;
}

export const ZERO_OID = /^0+$/;
