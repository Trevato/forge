/**
 * Settings › Danger zone: the one door that deletes a repository. The page
 * says what goes and what survives; the POST refuses unless the repository's
 * full name was typed back. The frame and the admin gate are settings.ts's.
 */

import { deleteRepo } from "../../actions/repos.ts";
import { notePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { isContributionFork } from "../../core/contribute.ts";
import { loadRepo, repoBase, repoNotFound } from "../chrome.ts";
import { DELETE_REPO } from "../danger_words.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo } from "../layout.ts";
import { card, confirmAction } from "../ui.ts";
import { detachCard } from "./detach.ts";
import { adminForm, settingsPageResponse, timedAdminRepo } from "./settings.ts";

export function dangerPage(ctx: Ctx): Response {
  const repo = timedAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const rendering = performance.now();
  const base = repoBase(repo);
  const full = `${repo.ownerName}/${repo.name}`;

  const body = card(
    html`<p>
        Deleting <strong>${full}</strong> removes its issues, pull requests,
        reviews, labels and webhooks, and erases the git objects from disk.
      </p>
      <p class="muted small mt">
        Any fork of this repository is detached first — it repacks so it owns
        its objects, then loses the link. Forks survive; this repository does
        not. There is no undo and no backup.
      </p>
      <div class="form-actions">
        ${confirmAction({
          action: `${base}/settings/delete`,
          verb: DELETE_REPO,
        })}
      </div>`,
    {
      tone: "danger",
      head: html`${icon("alert")}
        <h2>${DELETE_REPO}</h2>`,
    },
  );
  const detach = detachCard(ctx.app.db, repo, ctx.auth.user);
  const response = settingsPageResponse(
    ctx,
    repo,
    "danger",
    "Danger zone",
    detach === null ? body : html`${detach}<div class="mt">${body}</div>`,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const HAS_PULLS = "This repository stays: a pull request was sent from it, and that pull request needs it. Nothing was deleted.";

/** The admin's form, or a guest's on their own fork: the one thing they may do to it besides push. */
async function deleteForm(ctx: Ctx): ReturnType<typeof adminForm> {
  const repo = loadRepo(ctx);
  if (repo === undefined || repo.ownerId !== ctx.auth.user?.id || !isContributionFork(ctx.app.db, repo.id))
    return adminForm(ctx);
  const form = await readForm(ctx, "admin");
  return form instanceof Response ? form : { repo, form };
}

/**
 * The typed-name check lives here and nowhere else: the confirm page collects
 * the phrase, this handler is the one that refuses without it.
 */
export async function repoDelete(ctx: Ctx): Promise<Response> {
  const gate = await deleteForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const full = `${repo.ownerName}/${repo.name}`;
  if (field(form, "confirm") !== full) {
    return flashTo(ctx, `${repoBase(repo)}/settings/danger`, {
      tone: "danger",
      message: `Type ${full} exactly to confirm. Nothing was deleted.`,
    });
  }
  const deleted = await deleteRepo(ctx.app, ctx.auth.user, repo);
  if (!deleted.ok) {
    return flashTo(ctx, `${repoBase(repo)}/settings/danger`, {
      tone: "danger",
      message: deleted.error === "has_pulls" ? HAS_PULLS : "The repository could not be deleted.",
    });
  }
  return flashTo(ctx, "/", { message: `${full} was deleted.` });
}
