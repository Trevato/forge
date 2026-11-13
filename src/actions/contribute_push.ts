/**
 * What an outside agent's push does beyond landing a branch (#12013). Before it
 * lands, a new branch is refused with the number when the token's pull caps are
 * spent. After it lands, a new `contrib/…` branch opens a pull (the tip commit's
 * message is its title and body) and a later push finds the same pull; the lines
 * returned are what the push prints back to the agent: the pull's URL and the
 * plain-text URL of its checks.
 */

import type { App } from "../app.ts";
import { capWords, inTurn, pullCapReached, pullRoom } from "../core/contribute_token.ts";
import { MAX_BODY, MAX_TITLE } from "../core/issues.ts";
import { pullForBranch } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { ZERO_OID, type RefUpdate } from "../git/hook-protocol.ts";
import { repoDir } from "../git/repos.ts";
import { openPull } from "./pulls.ts";

const HEADS = "refs/heads/";

const errorText = (error: unknown): string => (typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error));

/** Branches this push creates: the ones that would open a pull. */
const created = (updates: readonly RefUpdate[]): RefUpdate[] =>
  updates.filter((u) => u.ref.startsWith(HEADS) && ZERO_OID.test(u.oldOid) && !ZERO_OID.test(u.newOid));

/**
 * The one plain line refusing this push because its pull caps are spent, or because
 * it creates more branches than there is room for pulls; undefined otherwise.
 */
export function contribPushRefusal(app: App, repo: Repo, userId: string, updates: readonly RefUpdate[], now = new Date()): string | undefined {
  const fresh = created(updates).length;
  if (fresh === 0) return undefined;
  const { room, capped } = pullRoom(app.db, repo.id, userId, now);
  if (capped !== undefined) return `not pushed: ${capWords(capped)}`;
  if (fresh > room)
    return `not pushed: this push creates ${fresh} new branches and this token may open ${room} more pull${room === 1 ? "" : "s"} now; push fewer branches at a time`;
  return undefined;
}

/** The commit's message split into a title (its first line) and the whole message as the body. */
export function pullWords(message: string, branch: string): { title: string; body: string } {
  const text = message.replace(/\r\n?/g, "\n").trim();
  const title = (text.split("\n", 1)[0] ?? "").trim().slice(0, MAX_TITLE) || branch;
  return { title, body: text.slice(0, MAX_BODY) };
}

/** Open or find the pull of every branch the push moved; the lines the push prints. */
export async function contribPushPulls(
  app: App,
  repo: Repo,
  actor: User | undefined,
  updates: readonly RefUpdate[],
  origin: string,
): Promise<string[]> {
  const lines: string[] = [];
  if (actor === undefined) return lines;
  const at = `${origin}/${repo.ownerName}/${repo.name}`;
  const show = (number: number, verb: string): void => {
    lines.push(`${verb} pull #${number}: ${at}/pulls/${number}`);
    lines.push(`checks (plain text): ${origin}/api/v1/repos/${repo.ownerName}/${repo.name}/pulls/${number}/checks?format=text`);
  };
  for (const update of updates) {
    if (!update.ref.startsWith(HEADS) || ZERO_OID.test(update.newOid)) continue;
    const branch = update.ref.slice(HEADS.length);
    const known = pullForBranch(app.db, repo.id, branch);
    if (known !== undefined && known.state === "open" && known.mergedAt === null) {
      show(known.number, "updated");
      continue;
    }
    const log = await runGit(["log", "-1", "--format=%B", update.newOid], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) });
    const words = pullWords(log.ok ? log.value : "", branch);
    // One open at a time per token, with the caps read inside the turn (as the API's does).
    const opened = await inTurn(actor.id, async () => {
      const capped = pullCapReached(app.db, repo.id, actor.id, new Date());
      if (capped !== undefined) return capped;
      return openPull(app, actor, repo, {
        title: words.title,
        body: words.body,
        baseBranch: repo.defaultBranch,
        headBranch: branch,
        outsideAgent: true,
      });
    });
    if (typeof opened === "string") lines.push(`${branch} is pushed but no pull was opened: ${capWords(opened)}`);
    else if (opened.ok) show(opened.value.number, "opened");
    else lines.push(`${branch} is pushed but no pull was opened (${errorText(opened.error)}): open one with POST /api/v1/repos/${repo.ownerName}/${repo.name}/pulls`);
  }
  return lines;
}
