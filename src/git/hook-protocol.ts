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
  readonly updates: readonly RefUpdate[];
  /**
   * Quarantine environment forwarded from the hook process. Any git command
   * evaluating not-yet-accepted objects (ancestry checks in pre-receive)
   * must run with these, or the new objects are invisible to it.
   */
  readonly gitEnv: Record<string, string>;
}

export const FORWARDED_GIT_ENV = [
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
] as const;

export function parseHookStdin(text: string): RefUpdate[] {
  const updates: RefUpdate[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const [oldOid, newOid, ref] = line.split(" ");
    if (!oldOid || !newOid || !ref) continue;
    updates.push({ oldOid, newOid, ref });
  }
  return updates;
}

export const ZERO_OID = /^0+$/;
