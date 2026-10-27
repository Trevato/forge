/**
 * The FLOW ONLY switch, said once and quietly (#6394): one line on the
 * repository header and one per repository on its owner's home, each linking
 * to the setting. Nothing at all while the switch is off.
 */
import type { Database } from "bun:sqlite";
import { canAdmin, listReposWritableTo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { html, type Html } from "./html.ts";

const TEXT = "Flow only: building flow issues alone";

/** The line for one repository; null while its switch is off. */
export function flowOnlyLine(repo: Repo, admin: boolean, withName = false): Html | null {
  if (!repo.flowOnly) return null;
  const base = `/${repo.ownerName}/${repo.name}`;
  // The setting is an admin's page: for anyone else the words are plain.
  return html`<p class="muted small">
    ${withName ? html`<a href="${base}">${repo.ownerName}/${repo.name}</a>: ` : null}${admin
      ? html`<a href="${base}/settings/crew#flow-only">${TEXT}</a>`
      : TEXT}
  </p>`;
}

/** One line for each repository this person administers that has the switch on. */
export function flowOnlyHomeLines(db: Database, user: User): Html | null {
  const lines = listReposWritableTo(db, user, { withoutArchived: true })
    .filter((r) => r.flowOnly && canAdmin(db, r, user))
    .map((r) => flowOnlyLine(r, true, true));
  return lines.length === 0 ? null : html`${lines}`;
}
