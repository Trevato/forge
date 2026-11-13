/**
 * Land it as it is (#11892): when the crew cannot go on (its included credit
 * is spent, or it has no model key) a green pull still lands. One sentence
 * says why the crew stopped; the pull's own ship action follows (squash,
 * `POST …/pulls/:n/ship`, same-origin checked, `mergePull` behind it), with
 * the preview beside it and, for an admin, the way to add a key. A red or
 * held pull is never offered it. `landable` and `landWords` give the pages,
 * the MCP `merge` tool and the terminal screen the same rows and the same
 * refusals.
 */

import type { App } from "../../app.ts";
import { requireWriter } from "../../actions/access.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { listOpenPulls, type Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { checkSummary } from "../../core/runs.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { btn, card, listCard, row } from "../ui.ts";
import { crewCanRun, hasCrew, includedCredit } from "./crew_key.ts";
import { changeHref } from "./nouns.ts";

/** The one label, on the page, in the terminal and in the MCP tool's `action`. */
export const LAND_AS_IS = "Land it as it is";
export const ADD_KEY_HREF = "/settings/subscriptions";

/**
 * Why the crew cannot go on, in one plain sentence; null while it can, or when there is no
 * crew to stop.
 */
export function stalledWords(app: App): string | null {
  if (!hasCrew(app) || crewCanRun(app)) return null;
  return includedCredit(app) !== undefined
    ? "The crew cannot go on: the included credit is spent."
    : "The crew cannot go on: it has no model key.";
}

/**
 * The open pulls of this repository the viewer may land as they are: a writer's, the crew
 * stopped, the check green.
 */
export function landable(app: App, user: User | undefined, repo: Repo): Pull[] {
  if (stalledWords(app) === null || !requireWriter(app, user, repo).ok) return [];
  return listOpenPulls(app.db, repo.id).filter((p) => p.mergedAt === null && checkSummary(app.db, p.id, p.headOid).state === "ok");
}

/** Where a pull's preview opens, when the repository is an app. */
const previewOf = (app: App, repo: Repo, pull: Pull): string | undefined =>
  getAppByRepo(app.db, repo.id) === undefined ? undefined : `${repoBase(repo)}/app/pull-${pull.number}/open`;

const landForm = (repo: Repo, pull: Pull): Html =>
  html`<form method="post" action="${repoBase(repo)}/pulls/${pull.number}/ship" data-now="Landing">${btn(LAND_AS_IS, { size: "sm", variant: "primary", icon: "merge" })}</form>`;

/** Who may add a key gets the link; anyone else is told why there is none. */
const keyOffer = (ctx: Ctx): Html =>
  ctx.auth.user?.isAdmin === true
    ? btn("Add a key", { href: ADD_KEY_HREF, size: "sm" })
    : html`<span class="muted small">Only this forge's admin can add a key.</span>`;

/** The pull's own page: the sentence, the button, the preview beside it, the key. */
export function landAsIs(ctx: Ctx, repo: Repo, pull: Pull): Html | null {
  const words = stalledWords(ctx.app);
  if (words === null || !landable(ctx.app, ctx.auth.user, repo).some((p) => p.id === pull.id)) return null;
  return card(
    html`<div class="bar">${landForm(repo, pull)}${when(previewOf(ctx.app, repo, pull), (href) => btn("Preview", { href, size: "sm" }))}${keyOffer(ctx)}</div>`,
    { id: "land-as-is", head: html`${words}`, attrs: html`data-land-as-is role="status"` },
  );
}

/**
 * The app's page: the sentence once, then one row per green pull with its button. Reads
 * nothing while the crew can go on.
 */
export function landOnApp(ctx: Ctx, repo: Repo): Html | null {
  const words = stalledWords(ctx.app);
  const green = words === null ? [] : landable(ctx.app, ctx.auth.user, repo);
  if (words === null || green.length === 0) return null;
  return listCard(
    green.map((pull) =>
      row({
        title: html`<a href="${changeHref(repoBase(repo), pull.number)}">${pull.title}</a>`,
        trail: html`<span class="bar">${landForm(repo, pull)}${when(previewOf(ctx.app, repo, pull), (href) => btn("Preview", { href, size: "sm" }))}</span>`,
      }),
    ),
    { id: "land-as-is", head: html`${words} ${keyOffer(ctx)}`, attrs: html`data-land-as-is role="status"` },
  );
}
