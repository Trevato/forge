/**
 * The Held files card on /boards: every file held in a repository the viewer
 * administers (`adminRepoIds`), read in one statement with no per-row
 * `canRead` — the rule `listFileHolds` keeps, so a private repository's hold
 * shows to its admins only. The card shows with no holds yet, for it holds the
 * form. `POST /boards/holds` hands the form to the shared handler
 * (`file_holds.ts`) and returns to /boards.
 */

import type { Database } from "bun:sqlite";
import { administersAny } from "../../core/admin_repos.ts";
import { boardHolds, type BoardHold } from "../../core/admin_holds.ts";
import { getRepo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { MAX_HOLD_PATH } from "../../crew/file_holds.ts";
import type { Ctx } from "../../http/context.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { btn, card, field as formField, row, time } from "../ui.ts";
import { fileHoldForm } from "./file_holds.ts";

/** `owner/name`: two names and a slash. */
const MAX_REPO_REF = 80;

/** Null unless `viewer` administers some repository. */
export function boardsHoldsCard(db: Database, viewer: User | undefined, withBoards = false): Html | null {
  if (viewer === undefined || !administersAny(db, viewer)) return null;
  const { holds, total } = boardHolds(db, viewer);
  const release = (h: BoardHold): Html =>
    html`<form method="post" action="/boards/holds">
      <input type="hidden" name="repo" value="${h.repo}" />
      <input type="hidden" name="path" value="${h.path}" />
      <input type="hidden" name="verb" value="release" />
      ${btn("Release", { variant: "ghost" })}
    </form>`;
  return card(
    html`<p class="muted small">
        No build starts on an issue that names a held path. Nothing already
        running is cut. Only repositories you administer are listed.
      </p>
      ${total > holds.length
        ? html`<p class="muted small" data-cut>Showing ${String(holds.length)} of ${String(total)} holds; release some to see the rest.</p>`
        : null}
      ${holds.length === 0
        ? html`<p class="muted" data-no-holds>No file is held.</p>`
        : html`<ul class="list setting-list">
            ${holds.map((h) =>
              row({
                title: html`<span class="mono">${h.path}</span> <span class="muted small">${h.repo}</span>`,
                meta: html`held by <span data-by>${h.byName}</span> · ${time(h.at)}`,
                data: { "file-hold": h.path, repo: h.repo },
                trail: release(h),
              }),
            )}
          </ul>`}
      <form method="post" action="/boards/holds">
        <input type="hidden" name="verb" value="hold" />
        ${formField({ label: "Repository", name: "repo", maxlength: MAX_REPO_REF, placeholder: "owner/name", mono: true, required: true, spellcheck: false })}
        ${formField({
          label: "Hold new work on",
          name: "path",
          placeholder: "src/http/mcp.ts",
          mono: true,
          required: true,
          maxlength: MAX_HOLD_PATH,
          spellcheck: false,
          hint: `A path in the repository, relative, at most ${MAX_HOLD_PATH} characters.`,
        })}
        <div class="form-actions">${btn("Hold file", { variant: withBoards ? "secondary" : "primary" })}</div>
      </form>`,
    { id: "board-holds", head: html`${icon("alert")}<h2>Held files</h2>` },
  );
}

// POST /boards/holds
export async function boardsHoldPost(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const [owner = "", name = "", ...extra] = field(form, "repo").trim().split("/");
  const repo = extra.length === 0 && owner !== "" && name !== "" ? getRepo(ctx.app.db, owner, name) : undefined;
  return fileHoldForm(ctx, form, repo, "/boards#board-holds");
}
