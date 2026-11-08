/**
 * Settings › Danger zone › "Detach from parent" (#7452). The card is the
 * plan — what the detach copies and what it ends — and its button starts
 * it. While the repack runs the card says so and since when; a failure
 * stays on the card with git's line until the next try. The button goes
 * through /-/confirm first (#7978): the detach has no undo. The mechanics are
 * `actions/detach.ts`.
 */

import { detachFromParent, detachJob } from "../../actions/detach.ts";
import { forkParentFor, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo } from "../layout.ts";
import { card, confirmAction, timeAgo } from "../ui.ts";
import type { Database } from "bun:sqlite";
import { adminForm } from "./settings.ts";

/** The card, for a fork; null on a repository that follows nothing. */
export function detachCard(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
): Html | null {
  if (repo.forkParentId === null) return null;
  // Named only for an admin who may read it; a fork never speaks for a
  // parent that was not opened to them.
  const parent = forkParentFor(db, repo, viewer);
  const name = parent === undefined ? "its parent" : `${parent.ownerName}/${parent.name}`;
  const job = detachJob(repo.id);
  const body =
    job?.phase === "repacking"
      ? html`<p data-detach-progress>
          ${icon("sync")} Detaching from ${name}: copying the objects it lends
          into this repository, started ${timeAgo(job.startedAt)}. Reload to
          see it finish; pushes and clones keep working meanwhile.
        </p>`
      : html`${job?.phase === "failed"
            ? html`<div class="toast" data-tone="danger" role="status" data-detach-failed>
                ${icon("alert")}
                <div class="toast-body">
                  The last detach stopped: ${job.message}. Nothing changed; try
                  again.
                </div>
              </div>`
            : null}
          <p>
            Copies every object this fork borrows from <strong>${name}</strong>
            into its own store, drops the link, then forgets the parent: no
            Following card, no updates to take, nothing to propose upstream.
            Branches, history, issues and pulls stay. There is no undo.
          </p>
          <div class="form-actions">
            ${confirmAction({ action: `${repoBase(repo)}/settings/detach`, verb: "Detach from parent" })}
          </div>`;
  return card(body, {
    id: "detach",
    tone: "danger",
    head: html`${icon("fork")}
      <h2>Detach from parent</h2>`,
  });
}

/** POST /:owner/:name/settings/detach — start the detach; the card shows it. */
export async function detachSubmit(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const back = `${repoBase(repo)}/settings/danger`;
  const started = await detachFromParent(ctx.app, ctx.auth.user, repo, false);
  if (!started.ok)
    return flashTo(ctx, back, {
      tone: "danger",
      message:
        started.error === "running"
          ? "A detach is already running."
          : started.error === "not_a_fork"
            ? "This repository has no parent to detach from."
            : "Only an admin of this repository detaches it.",
    });
  return flashTo(ctx, back, {
    message: `Detaching from ${started.value.parent ?? "its parent"}: the repack runs on its own.`,
  });
}
