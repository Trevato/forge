/**
 * Home says what is being held back for a person (#8700): one line per
 * repository whose Later gate holds open issues — how many, who set the
 * gate, when — and a link that opens the list.
 */

import { gateHold } from "../../core/gate_hold.ts";
import { reposWithUmbrellas } from "../../core/pillars.ts";
import { canWrite, listReposOwnedBy, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { time } from "../ui.ts";
import { writableAppsOf } from "./asks.ts";

/** The repositories whose gate holds work back from this person, with the hold. */
function holds(ctx: Ctx, user: User) {
  const db = ctx.app.db;
  const own = listReposOwnedBy(db, user.id);
  const byId = new Map<string, Repo>(own.map((r) => [r.id, r]));
  for (const r of writableAppsOf(ctx, user).repos) byId.set(r.id, r);
  const withUmbrellas = reposWithUmbrellas(db, [...byId.keys()]);
  const out = [];
  for (const id of withUmbrellas) {
    const repo = byId.get(id)!;
    if (!canWrite(db, repo, user)) continue;
    const hold = gateHold(db, repo);
    if (hold !== undefined) out.push({ repo, hold });
  }
  return out;
}

/** One line for each gate that holds work back; nothing where none does. */
export function heldLine(ctx: Ctx, user: User): Html | null {
  const found = holds(ctx, user);
  if (found.length === 0) return null;
  return html`<section class="stack stack-tight" id="held-line" aria-label="Held back">
    ${found.map(
      ({ repo, hold }) =>
        html`<p class="small">
          <a href="${repoBase(repo)}/held"
            >${hold.held} ${hold.held === 1 ? "issue is" : "issues are"} held
            behind the Later gate</a
          >
          in ${repo.name}, set by ${hold.by} ${time(hold.since)}
        </p>`,
    )}
  </section>`;
}
