/**
 * What the home keeps of the living pipeline of #8015: the box that tells the
 * crew (`tellBox`, with its Notes and Talk doors) and the pipeline's four
 * words as data for the terminal's dashboard (`pipelineNow`). The home itself
 * is `pages/home_flow.ts`; the lists that were here (Being built, Just
 * shipped) are the lanes now.
 */

import type { Database } from "bun:sqlite";
import { nowOf, type Now } from "../../flow/moving.ts";
import { readPipeline } from "../../flow/pipeline.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";
import { writableAppsOf } from "./asks.ts";
import { FORGE_TARGET, NEW_APP_TARGET } from "./feed.ts";
import { appsFirst } from "../../actions/first_ask.ts";
import { COMPOSER_FIELDS, TELL_MAX, sharedDraft, shareToken } from "../share_target.ts";

const NOW_TTL_MS = 3_000;
// One entry per forge, not per viewer: the counts are forge-wide, so only a site admin is ever shown them.
const nows = new WeakMap<Database, { at: number; now: Now }>();

/** Admin only: the caller has checked. The pipeline counts, read at most every few seconds: the same stages `/boards` draws. */
export function pipelineNow(db: Database, at = Date.now()): Now {
  const kept = nows.get(db);
  if (kept !== undefined && at - kept.at < NOW_TTL_MS) return kept.now;
  const now = nowOf(readPipeline(db, new Date(at)));
  nows.set(db, { at, now });
  return now;
}

/** The box that tells the crew: one line, the app it goes to, Tell. Posts to `/tell` as the composer does. */
export function tellBox(ctx: Ctx, user: User): Html {
  const { repos } = writableAppsOf(ctx, user);
  const slug = (r: { ownerName: string; name: string }) => `${r.ownerName}/${r.name}`;
  const shared = sharedDraft(ctx.url.searchParams);
  const { ordered, onlyForgeCopy } = appsFirst(ctx.app, repos);
  return html`<form id="tell-box" class="bar tell-box" method="post" action="/tell">
    ${shared === "" ? "" : html`<input type="hidden" name="${COMPOSER_FIELDS.once}" value="${shareToken(user.id, shared)}" />`}
    <input class="input" name="${COMPOSER_FIELDS.text}" maxlength="${String(TELL_MAX)}" required placeholder="Tell the crew…" aria-label="Tell the crew" data-draft="${user.id}" value="${shared.replace(/\s+/g, " ")}" />
    ${repos.length === 0
      ? html`<input type="hidden" name="${COMPOSER_FIELDS.app}" value="${FORGE_TARGET}" />`
      : onlyForgeCopy
        ? html`<input type="hidden" name="${COMPOSER_FIELDS.app}" value="${NEW_APP_TARGET}" />`
        : html`<select name="${COMPOSER_FIELDS.app}" class="input" aria-label="Send to">
          ${ordered.map((r) => html`<option value="${slug(r)}">${slug(r)}</option>`)}
          <option value="${FORGE_TARGET}">the forge</option>
        </select>`}
    ${btn("Tell", { variant: "primary" })}
  </form>
  <p class="small muted home-doors">
    <a href="/notes" title="Your notes and where they stand">Notes</a> 
    <a href="/talk" title="Talk to the forge">Talk</a>
  </p>`;
}
