/**
 * One comment row (a row of the timeline, no box), shared by the full page render and the live-append
 * fragment so a comment that arrives over SSE looks identical to one that was
 * on the page at load. The `data-comment-id` is what the client tracks to know
 * what it has already shown — it is load-bearing, not decoration.
 */

import type { Mark } from "../core/marks.ts";
import { html, when, type Html } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { icon, originTag, time, userLink, type IconName } from "./ui.ts";

export interface CommentCard {
  /** "" for the opener (the issue/PR body), which has no comment row. */
  id: string;
  author: string;
  /** The author's mark, from their account (`core/marks.ts`), never their words. */
  mark?: Mark | undefined;
  at: string;
  body: string;
  /** "opened" | "commented" | "wants to merge …" */
  verb: Html | string;
  /** Set when this came from an origin: the login there, and that forge's
   * mark. It replaces the local byline rather than sitting beside it. */
  originAuthor?: string | null;
  originKind?: IconName;
  /** The canonical URL at the origin, for "view on origin". */
  originUrl?: string | null;
}

export function commentCard(card: CommentCard): Html {
  const idAttr = card.id === "" ? html`` : html`data-comment-id="${card.id}" `;
  const bodyHtml =
    card.body.trim() === ""
      ? html`<p class="muted">No description.</p>`
      : renderMarkdown(card.body);
  const byline =
    card.originAuthor != null && card.originAuthor !== ""
      ? originTag(card.originAuthor, card.originKind ?? "globe")
      : userLink(card.author, { mark: card.mark });
  return html`<div ${idAttr}class="comment-row">
    <div class="comment-head">
      ${byline}
      <span class="muted">${card.verb} ${time(card.at)}</span>
      ${when(
        card.originUrl != null && card.originUrl !== "",
        () => html`<span class="spacer"></span>
          <a
            class="bar muted small"
            href="${card.originUrl ?? ""}"
            rel="noreferrer noopener"
            >${icon("external")}view on origin</a
          >`,
      )}
    </div>
    <div class="prose comment-body">${bodyHtml}</div>
  </div>`;
}
