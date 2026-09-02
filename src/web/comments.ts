/**
 * One comment card, shared by the full page render and the live-append
 * fragment so a comment that arrives over SSE looks identical to one that was
 * on the page at load. The `data-comment-id` is what the client tracks to know
 * what it has already shown — it is load-bearing, not decoration.
 */

import { html, type Html } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { time, userLink } from "./ui.ts";

export interface CommentCard {
  /** "" for the opener (the issue/PR body), which has no comment row. */
  id: string;
  author: string;
  at: string;
  body: string;
  /** "opened" | "commented" | "wants to merge …" */
  verb: Html | string;
}

export function commentCard(card: CommentCard): Html {
  const idAttr = card.id === "" ? html`` : html`data-comment-id="${card.id}" `;
  const bodyHtml =
    card.body.trim() === ""
      ? html`<p class="muted">No description.</p>`
      : renderMarkdown(card.body);
  return html`<div ${idAttr}class="card comment">
    <div class="card-head">
      ${userLink(card.author)}
      <span class="muted">${card.verb} ${time(card.at)}</span>
    </div>
    <div class="prose comment-body">${bodyHtml}</div>
  </div>`;
}
