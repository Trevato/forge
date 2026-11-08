/**
 * The throughput keeper on a page (#7645): one muted line, the cause binding
 * landings and the last thing it did, and, when it asks, the question with
 * its one button. Home and the pipeline panel both draw it; `POST
 * /flow/keeper/answer` is the button (a site admin's, same-origin).
 */

import type { Database } from "bun:sqlite";
import { answerKeeper, keeperLine, readKeeper } from "../../flow/keeper.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst, NOT_ADMIN_HERE, forbiddenPage } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { redirect } from "../layout.ts";
import { btn } from "../ui.ts";

export function keeperRow(db: Database, full: boolean): Html {
  const read = readKeeper(db, full);
  const line = keeperLine(read);
  if (line === "" && read.ask === null) return html``;
  return html`${line === "" ? null : html`<p class="small muted break" id="keeper">${line}</p>`}
    ${read.ask === null
      ? null
      : html`<form method="post" action="/flow/keeper/answer" id="keeper-ask" class="bar small">
          <span>${read.ask.question}</span>
          <input type="hidden" name="id" value="${String(read.ask.id)}" />
          ${btn(read.ask.button, { type: "submit" })}
        </form>`}`;
}

// POST /flow/keeper/answer — the one button on the keeper's question.
export async function keeperAnswer(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  if (!ctx.auth.user.isAdmin) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  const raw = form.get("id");
  const id = typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  const answered = id > 0 ? answerKeeper(ctx.app, id, ctx.auth.user.id) : { done: false, message: "That question is already answered." };
  return redirect("/", {
    url: ctx.url,
    forgeUrl: ctx.app.config.url,
    flash: { tone: answered.done ? "success" : "danger", message: answered.message },
  });
}
