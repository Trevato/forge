/**
 * The hold-a-file card on a repository's settings, an admin's: each file
 * held, who set it and when, what it keeps waiting, a form to hold another
 * path and one to release. The forms post to `fileHoldUpdate`
 * (`pages/file_holds.ts`), which is where the admin and same-origin checks are.
 */

import { listFileHolds } from "../../actions/file_holds.ts";
import type { Repo } from "../../core/repos.ts";
import { heldNow } from "../../crew/held.ts";
import { MAX_HOLD_PATH } from "../../crew/file_holds.ts";
import type { Ctx } from "../../http/context.ts";
import { html, type Html } from "../html.ts";
import { btn, field, row, time } from "../ui.ts";

/** Null unless the viewer is an admin of `repo`: the holds are the owner's book-keeping. */
export function fileHoldsCard(ctx: Ctx, repo: Repo, base: string): Html | null {
  const listed = listFileHolds(ctx.app, ctx.auth.user, repo);
  if (!listed.ok) return null;
  const waiting = listed.value.length === 0 ? undefined : heldNow(ctx.app, repo).pinned;
  const issuesOf = (path: string): string =>
    [...(waiting ?? [])]
      .filter(([, h]) => h.path === path)
      .map(([n]) => `#${n}`)
      .join(" ");
  return html`<section class="settings-block" id="file-holds">
    <h2>Held files</h2>
    <p class="muted small">
        No build starts on an issue that names a held path. Nothing already
        running is cut.
      </p>
      ${listed.value.length === 0
        ? html`<p class="muted" data-no-holds>No file is held.</p>`
        : html`<ul class="list setting-list">
            ${listed.value.map((h) => {
              const kept = issuesOf(h.path);
              return row({
                title: html`<span class="mono">${h.path}</span>`,
                meta: html`held by <span data-by>${h.byName}</span> · ${time(h.at)}${kept === "" ? "" : html` · keeping ${kept} waiting`}`,
                data: { "file-hold": h.path },
                trail: html`<form method="post" action="${base}/settings/holds">
                  <input type="hidden" name="path" value="${h.path}" />
                  <input type="hidden" name="verb" value="release" />
                  ${btn("Release", { variant: "ghost" })}
                </form>`,
              });
            })}
          </ul>`}
      <form method="post" action="${base}/settings/holds">
        <input type="hidden" name="verb" value="hold" />
        ${field({
          label: "Hold new work on",
          name: "path",
          placeholder: "src/http/mcp.ts",
          mono: true,
          required: true,
          spellcheck: false,
          hint: `A path in the repository, relative, at most ${MAX_HOLD_PATH} characters.`,
        })}
        <div class="form-actions">${btn("Hold file", { variant: "primary" })}</div>
      </form>
  </section>`;
}
