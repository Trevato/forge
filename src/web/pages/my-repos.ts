/**
 * Your repositories: every repository the viewer may write, their own and
 * their organizations', newest first, each a link to it.
 */

import { listReposWritableTo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, empty, listCard, row } from "../ui.ts";

// GET /repos
export function myReposPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const reading = performance.now();
  const repos = listReposWritableTo(ctx.app.db, user, { limit: 200, withoutArchived: true });
  const body =
    repos.length === 0
      ? empty({ icon: "repo", title: "No repositories yet", action: btn("New repository", { href: "/new", variant: "primary" }) })
      : listCard(
          repos.map((r) =>
            row({ href: repoBase(r), nav: true, title: html`<span class="truncate">${r.ownerName}/${r.name}</span>` }),
          ),
        );
  notePhase(ctx.request, "render", performance.now() - reading);
  return page({
    ctx,
    title: "Your repositories",
    body: html`<div class="page-head"><h1>Your repositories</h1>${repos.length === 0 ? null : btn("New repository", { href: "/new" })}</div>${body}`,
  });
}
