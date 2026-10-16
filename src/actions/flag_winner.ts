/**
 * Make a flag's winner the default (#1829): the flag reads the winner at once
 * for everyone (per-user, role and percentage rules cleared), and an issue on
 * the forge's repository asks the crew to remove the losing path and the flag.
 * Only the variant the read-out offers (`winnerOffer`: enough reads, no tie,
 * not already the value) is accepted, whichever door asks. The issue is opened first, so a refusal leaves the flag as it was.
 */

import type { App } from "../app.ts";
import { flagRegistry, mayManageFlags, winnerOffer } from "../core/flags.ts";
import type { Issue } from "../core/issues.ts";
import { getRepo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { openIssue } from "./issues.ts";

export function makeWinnerDefault(
  app: App,
  actor: User,
  name: string,
  winner: "on" | "off",
): { ok: true; issue: Issue } | { ok: false; message: string } {
  if (!mayManageFlags(actor)) return { ok: false, message: "Flags are set by a forge admin." };
  const registry = flagRegistry();
  const decl = (registry.decls as Record<string, { why: string; issue: number }>)[name];
  if (!Object.hasOwn(registry.decls, name) || decl === undefined)
    return { ok: false, message: "There is no such flag." };
  if (winnerOffer(registry.uses(app.db, name, 30), registry.value(name as never)) !== winner)
    return { ok: false, message: "That variant is not the winner yet." };
  const [owner, repoName] = (app.config.forgeRepo ?? "").split("/");
  const repo = owner && repoName ? getRepo(app.db, owner, repoName) : undefined;
  if (!repo) return { ok: false, message: "The forge names no repository to open the issue on." };
  const loser = winner === "on" ? "off" : "on";
  const issue = openIssue(app, actor, repo, {
    title: `Remove flag ${name}: keep the ${winner} path`,
    body:
      `The A/B read-out for \`${name}\` ended with **${winner}** the winner, and it is now the flag's value for everyone.\n\n` +
      `Remove the ${loser} path and the \`${name}\` flag (declared in \`src/core/flags.ts\`; owner #${decl.issue}). ` +
      `Flag: ${decl.why}`,
  });
  if (!issue.ok) return { ok: false, message: "The issue could not be opened." };
  registry.set(app.db, name, { forge: winner === "on" }, actor.id);
  return { ok: true, issue: issue.value };
}
