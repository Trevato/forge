/**
 * GET /:owner/:name/settings/app/statement?month=YYYY-MM — the app's
 * statement for one UTC month (#508, `core/revenue.ts`), as the API's
 * `…/statement` answers it: one row per line, quantity × price = amount, and
 * the total, in US dollars. Printing the page prints the statement alone:
 * the shared print rules (`style/base.ts`) hide the navigation and picker. For the
 * repository's admins and forge admins; anyone else gets the not-found page.
 */

import { STATEMENT_WORDS, mayReadStatement, readStatement } from "../../actions/statement.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, repoNotFound } from "../chrome.ts";
import { html } from "../html.ts";
import { settingsPageResponse } from "./settings.ts";

/** A quantity or price as its plain digits, never an exponent. */
const plain = (n: number): string =>
  n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 6 });

export function statementPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => {
    const r = loadRepo(ctx);
    return r !== undefined && mayReadStatement(ctx.app, r, ctx.auth.user) ? r : undefined;
  });
  if (!repo) return repoNotFound(ctx);
  const asked = ctx.url.searchParams.get("month");
  const read = timePhase(ctx.request, "statement", () =>
    readStatement(ctx.app, ctx.auth.user, repo, asked === null || asked === "" ? undefined : asked),
  );
  if (!read.ok && read.error === "not_found") return repoNotFound(ctx);
  const rendering = performance.now();
  const api = `/api/v1/repos/${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}/statement`;
  const picker = (month: string) => html`<form class="row-fields" method="get" data-statement-pick data-print-hide>
    <label class="small"
      >Month (UTC)
      <input class="input mono" type="month" name="month" min="2000-01" value="${month}" required
    /></label>
    <button class="btn" data-size="sm" type="submit">Show</button>
  </form>`;
  let body;
  if (!read.ok) {
    body = html`<section class="settings-block">
      <h2>Statement</h2>
      ${picker("")}
      <p role="alert">${STATEMENT_WORDS.bad_month}.</p>
    </section>`;
  } else {
    const s = read.value;
    const usd = (n: number) => `$${n.toFixed(2)}`;
    const q = `?month=${s.month}`;
    body = html`<section class="settings-block" data-statement data-print-alone>
      <h2>Statement for ${s.app}, ${s.month} (UTC)</h2>
      ${picker(s.month)}
      <div class="table-scroll mt">
        <table class="table">
          <thead>
            <tr><th>What</th><th class="num">Quantity</th><th>Unit</th><th class="num">Price (USD)</th><th class="num">Amount (USD)</th></tr>
          </thead>
          <tbody>
            ${s.lines.map(
              (l) => html`<tr>
                <td>${l.what}</td>
                <td class="num mono">${plain(l.quantity)}</td>
                <td>${l.unit}</td>
                <td class="num mono">${plain(l.price)}</td>
                <td class="num mono">${usd(l.amount)}</td>
              </tr>`,
            )}
          </tbody>
          <tfoot>
            <tr><th colspan="4">Total</th><th class="num mono" data-total>${usd(s.total)}</th></tr>
          </tfoot>
        </table>
      </div>
      <p class="small mt" data-statement-pick data-print-hide><a href="${api}${q}&format=csv">CSV</a> · <a href="${api}${q}">JSON</a></p>
    </section>`;
  }
  const response = settingsPageResponse(ctx, repo, "app", "Statement", body, undefined, read.ok ? 200 : 422);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
