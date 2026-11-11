/**
 * The one quiet line a mirror (or a fork of one) carries under its header:
 * where it was mirrored from, its licence and its original authors (#10531).
 * The reading is `core/credit.ts`, shared with the terminal.
 */

import { creditLead, creditOf, creditRest } from "../core/credit.ts";
import type { Repo } from "../core/repos.ts";
import type { RepoSource } from "../view/source.ts";
import type { Ctx } from "../http/context.ts";
import { html, type Html } from "./html.ts";

export async function creditLine(ctx: Ctx, repo: Repo, source: RepoSource, ref: string): Promise<Html> {
  const credit = await creditOf(ctx.app.db, ctx.app.reposRoot, repo, ctx.auth.user, source, ref);
  if (credit === undefined) return html``;
  const { upstream } = credit;
  const safe = /^https?:\/\//i.test(upstream.htmlUrl);
  return html`<p class="small muted">
    ${creditLead(credit)}
    ${safe
      ? html`<a href="${upstream.htmlUrl}" rel="noreferrer noopener">${upstream.fullName}</a>`
      : html`<span class="mono">${upstream.fullName}</span>`}${creditRest(credit)}
  </p>`;
}
