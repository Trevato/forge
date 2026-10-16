/**
 * GET /:owner/:name/tell?from=/path — the composer for a tell said from a
 * page. Without a script it is a page of its own (the palette's plain link);
 * with `in=place` it is only the form, which the palette's script lays over
 * the page it is on. Either way it is the thread's own comment box
 * (`composer`, pages/thread.ts) saying a tell, so there is one box to keep.
 */

import { parseContext } from "../../actions/tell_context.ts";
import { parseFrom } from "../../actions/tell.ts";
import { mayDirectCrew } from "../../crew/direct.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { composer } from "../pages/thread.ts";

export function tellHerePage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!mayDirectCrew(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  const from = parseFrom(ctx.url.searchParams.get("from") ?? undefined) ?? null;
  // The page of the app the toolbar was pressed on, and its pull: both
  // checked here and again when the tell is sent.
  const pull = ctx.url.searchParams.get("pull");
  const where = parseContext({
    ...(ctx.url.searchParams.has("page") ? { page: ctx.url.searchParams.get("page") } : {}),
    // A pull is only the pull of a page: alone it would be dropped on send.
    ...(pull !== null && ctx.url.searchParams.has("page") && /^\d{1,9}$/.test(pull)
      ? { pull: Number(pull) }
      : {}),
  });
  const text = (ctx.url.searchParams.get("text") ?? "").slice(0, 2000);
  const box = composer(ctx, {
    action: `${repoBase(repo)}/tell`,
    state: "open",
    closeLabel: "",
    tell: {
      from,
      rows: ctx.url.searchParams.get("in") === "place" ? 1 : 4,
      ...(text === "" ? {} : { text }),
      ...(where?.page === undefined ? {} : { page: where.page }),
      ...(where?.pull === undefined ? {} : { pull: where.pull }),
    },
  });
  if (ctx.url.searchParams.get("in") === "place")
    return fragment(box, { request: ctx.request });
  return page({
    ctx,
    title: `Tell the crew · ${repo.name}`,
    crumbs: crumbsFor(repo),
    body: html`${pageHead("Tell the crew")}${box}`,
  });
}
