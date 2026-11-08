/**
 * The radar files what is worth taking (#9592): one issue per dependency
 * whose newest upstream release is a stable version above the pin, saying in
 * plain words what changed, why it is useful and what could break. Never a
 * duplicate: a dependency with an open issue gets none, and a release already
 * filed (open or closed) is not filed again. Plain data in; issues out.
 */

import type { App } from "../app.ts";
import { assignIssue } from "../actions/issues.ts";
import { crewWithRole } from "../core/agents.ts";
import { createIssue, type Issue } from "../core/issues.ts";
import { getUserById } from "../core/users.ts";
import type { Repo } from "../core/repos.ts";
import type { Gap } from "./semver.ts";
import { parseSemver } from "./semver.ts";
import type { DepLine } from "./radar.ts";

const WHAT: Record<Exclude<Gap, "none">, string> = {
  patch: "a patch release: bug fixes only, no new features by the semver promise.",
  minor: "a minor release: new features that keep what exists working, by the semver promise.",
  major: "a major release: the maintainers say it may change or remove what you use.",
};
const WHY: Record<Exclude<Gap, "none">, string> = {
  patch: "Fixes (often security fixes) reach this repository at almost no cost.",
  minor: "New capabilities and fixes arrive while the old way keeps working.",
  major: "Staying on an old major means missing its fixes; a major left too long gets harder to take.",
};
const RISK: Record<Exclude<Gap, "none">, string> = {
  patch: "Low: a fix can still change behaviour someone relied on. Run the tests.",
  minor: "Moderate: a deprecation or a changed default may show up. Run the tests and read the changelog.",
  major: "High: expect breaking changes to the API. Read the migration notes before changing the pin, and change it in its own pull.",
};

/** The title that names a dependency; an open issue with this prefix is the one to leave alone. */
export const titlePrefix = (name: string): string => `Update ${name} to `;

/** Whether this line is a release worth an issue: a stable version above the pin. */
export function worthTaking(line: DepLine): line is DepLine & { gap: Exclude<Gap, "none"> } {
  const latest = parseSemver(line.latest);
  return line.gap !== "none" && line.error === "" && latest !== undefined && latest.pre === "";
}

export function updateBody(line: DepLine & { gap: Exclude<Gap, "none"> }, autonomous: boolean): string {
  return [
    `The radar read upstream: \`${line.name}\` is pinned at ${line.pinned} (\`${line.range}\` in ${line.dev ? "devDependencies" : "dependencies"}) and the newest release is ${line.latest}.`,
    "",
    `**What changed.** ${line.pinned} to ${line.latest} is ${WHAT[line.gap]}`,
    `**Why it is useful.** ${WHY[line.gap]}${line.dev ? " It is a development dependency, so it does not reach what runs in production." : ""}`,
    `**What could break.** ${RISK[line.gap]}`,
    "",
    autonomous
      ? "This repository is autonomous: the crew takes it from here and proposes the change as a pull."
      : "This repository is not autonomous: it waits for a person to take it or close it.",
  ].join("\n");
}

/**
 * Route a filed issue the way the forge already does: on an autonomous
 * repository it goes to a builder on the crew (assigning an agent is what
 * starts a run; `pick` marks it the crew's own pick so the week's pace still
 * holds it); otherwise it is assigned to the repository's owner, a person.
 * Without a builder (or an owner who is a person) it stays unassigned.
 */
function route(app: App, repo: Repo, issue: Issue): void {
  const owner = getUserById(app.db, repo.ownerId);
  if (owner === undefined || owner.kind !== "user") return;
  if (repo.autonomy === "autonomous") {
    const builder = crewWithRole(app.db, [repo.id], "builder").get(repo.id)?.[0];
    if (builder !== undefined) assignIssue(app, owner, repo, issue, builder.user, undefined, true);
    return;
  }
  assignIssue(app, owner, repo, issue, owner);
}

/** File an issue for each line worth taking that has none; returns the numbers filed. */
export function fileUpdates(app: App, repo: Repo, lines: readonly DepLine[]): number[] {
  const filed: number[] = [];
  for (const line of lines) {
    if (!worthTaking(line)) continue;
    const prefix = titlePrefix(line.name);
    const title = `${prefix}${line.latest}`;
    const held = app.db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'issue'
           AND ((state = 'open' AND substr(title, 1, length(?2)) = ?2) OR title = ?3)`,
      )
      .get(repo.id, prefix, title);
    if (held === null || held.n > 0) continue;
    const made = createIssue(app.db, {
      repoId: repo.id,
      authorId: repo.ownerId,
      title,
      body: updateBody(line, repo.autonomy === "autonomous"),
    });
    if (!made.ok) continue;
    app.bus.append({ kind: "issue.opened", repoId: repo.id, actorId: repo.ownerId, payload: { number: made.value.number } });
    route(app, repo, made.value);
    filed.push(made.value.number);
  }
  return filed;
}
