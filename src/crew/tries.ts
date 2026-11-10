/**
 * What the tries of a pull changed, in the words a park reason can carry.
 * A try is a head the check went red on; its files are the ones it changed
 * since the try before it (the first, since the base). A planner reading
 * "the decider saw no point in another try" learns nothing from it alone;
 * with the failing test and these lines it can see whether the tries kept
 * circling the same files.
 */

import type { App } from "../app.ts";
import { pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { listRuns } from "../core/runs.ts";
import { runGitCapture } from "../git/env.ts";

const OID = /^[0-9a-f]{40,64}$/;
/** Tries told, newest kept. */
const TRIES_TOLD = 5;
const FILES_PER_TRY = 10;
const LINE_MAX = 160;

/** `try 2: src/a.ts, src/b.ts (+3 more)`, one per line, oldest first; empty when none can be read. */
export async function triesChanged(
  app: App,
  repo: Repo,
  pull: Pull,
  since: string,
): Promise<string[]> {
  const heads: string[] = [];
  let earlier: string | undefined;
  for (const run of listRuns(app.db, repo.id, { issueId: pull.id, limit: 50 })
    .reverse()) {
    if (run.kind !== "check" && run.kind !== "deploy") continue;
    if (run.state !== "failed") continue;
    if (!OID.test(run.commitOid) || heads.includes(run.commitOid)) continue;
    // A try a person has answered is not told, but the first told one changed only what came after it.
    if (run.createdAt <= since) {
      earlier = run.commitOid;
      continue;
    }
    heads.push(run.commitOid);
  }
  if (heads.length === 0) return [];
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const lines: string[] = [];
  let before = earlier ?? pull.baseOid;
  for (const [n, head] of heads.entries()) {
    const out = OID.test(before)
      ? await runGitCapture(
          ["diff", "--name-only", "-z", "--no-renames", `${before}...${head}`, "--"],
          { cwd: dir },
        )
      : undefined;
    before = head;
    if (out === undefined || out.code !== 0) continue;
    const files = out.stdout.split("\0").filter((f) => f !== "");
    const shown = files.slice(0, FILES_PER_TRY).join(", ");
    const more = files.length > FILES_PER_TRY ? ` (+${files.length - FILES_PER_TRY} more)` : "";
    const line = `try ${n + 1}: ${files.length === 0 ? "no files changed" : shown + more}`;
    lines.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line);
  }
  return lines.slice(-TRIES_TOLD);
}
