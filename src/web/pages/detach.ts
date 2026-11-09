/**
 * Settings › Danger zone › "Detach from parent" (#7452). The section is the
 * plan — what the detach copies and what it ends — and its button starts
 * it. While the repack runs the section says so and since when; a failure
 * stays on it with git's line until the next try. The button goes
 * through /-/confirm first (#7978): the detach has no undo. The mechanics are
 * `actions/detach.ts`.
 */

import { detachFromParent, detachJob, type DetachJob } from "../../actions/detach.ts";
import { forkParentFor, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo } from "../layout.ts";
import { confirmAction, timeAgo } from "../ui.ts";
import type { Database } from "bun:sqlite";
import { adminForm } from "./settings.ts";

/** What the detach section shows: plain data, read by `detachSection`. */
export interface DetachView {
  /** owner/name of the parent, or "its parent" when the viewer may not read it. */
  readonly name: string;
  /** Where the confirmed detach posts. */
  readonly action: string;
  readonly job: DetachJob | undefined;
}

/** The section, for a fork; null on a repository that follows nothing. */
export function detachSection(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
): Html | null {
  if (repo.forkParentId === null) return null;
  // Named only for an admin who may read it; a fork never speaks for a
  // parent that was not opened to them.
  const parent = forkParentFor(db, repo, viewer);
  return detachBlock({
    name: parent === undefined ? "its parent" : `${parent.ownerName}/${parent.name}`,
    action: `${repoBase(repo)}/settings/detach`,
    job: detachJob(repo.id),
  });
}

/** The plan and its button, the repack running since when, or the last failure over the plan. */
export function detachBlock({ name, action, job }: DetachView): Html {
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
            ${confirmAction({ action, verb: "Detach from parent" })}
          </div>`;
  return html`<section class="settings-block" id="detach">
    <h2>Detach from parent</h2>
    ${body}
  </section>`;
}

/** POST /:owner/:name/settings/detach — start the detach; the section shows it. */
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
