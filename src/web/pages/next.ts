/**
 * Next up (#8694): `/:owner/:name/next`, the owner's one ranked list. The top
 * ten in rank order with who is on each and, in a line, why one cannot start
 * yet; everything else is one line that opens the rest. `Top`, `Up`, `Down`
 * and `Not now` are plain forms that save at once, so the keyboard and a
 * phone need no script; a row can also be dragged, or moved by the key shown
 * beside each action (`j`/`k` choose the row), which post the same form.
 */
import { placeOf, rankIssue, rankedWords, stepTo, type Place } from "../../actions/next.ts";
import { nextUp, TOP, type NextRow } from "../../core/next_up.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { sealedScope } from "../../core/sealed.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { backTo, field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashOrJson, page } from "../layout.ts";
import { badge, btn, card, kbd, row } from "../ui.ts";

const KEYS_JS = `
(() => {
  const list = document.getElementById("next-list");
  const remembered = sessionStorage.getItem("next-focus");
  if (remembered) {
    sessionStorage.removeItem("next-focus");
    const again = document.querySelector('li[data-number="' + remembered + '"] [data-nav]');
    if (again) again.focus();
  }
  const send = async (data, number) => {
    const res = await fetch(location.pathname, { method: "POST", body: new URLSearchParams(data), headers: { accept: "application/json" } });
    if (!res.ok) {
      // A refusal says why and changes nothing: the list stays as it is.
      const said = await res.json().catch(() => ({}));
      const note = document.getElementById("next-flash");
      note.textContent = said.error || "That move was refused.";
      note.hidden = false;
      return;
    }
    sessionStorage.setItem("next-focus", number);
    location.reload();
  };
  // One key, one action, on the row that has focus: the key is shown on the button.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
    const row = document.activeElement && document.activeElement.closest("li[data-number]");
    const form = row && row.querySelector('form[data-key="' + e.key + '"]');
    if (!form) return;
    e.preventDefault();
    send(new FormData(form), row.dataset.number);
  });
  if (!list) return;
  let held = null;
  list.querySelectorAll("li[data-number]").forEach((li) => { li.draggable = true; });
  list.addEventListener("dragstart", (e) => { held = e.target.closest("li[data-number]"); });
  list.addEventListener("dragover", (e) => { if (held) e.preventDefault(); });
  list.addEventListener("drop", (e) => {
    const over = e.target.closest("li[data-number]");
    if (!held || !over || over === held) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll("li[data-number]")];
    const rest = rows.filter((r) => r !== held);
    const at = rest.indexOf(over) + (rows.indexOf(over) > rows.indexOf(held) ? 1 : 0);
    send({ number: held.dataset.number, to: at === 0 ? "top" : "after:" + rest[at - 1].dataset.number }, held.dataset.number);
  });
})();`;

/** The one form a button is: a move for one issue, saved on submit. */
function move(base: string, number: number, to: string, label: string, key: string, back: string): Html {
  return html`<form method="post" action="${base}/next" data-key="${key}">
    <input type="hidden" name="number" value="${String(number)}" />
    <input type="hidden" name="to" value="${to}" />
    <input type="hidden" name="back" value="${back}" />
    ${btn(html`${label} ${kbd([key])}`, { variant: "outline", size: "sm" })}
  </form>`;
}

function line(base: string, rows: readonly NextRow[], at: number, writer: boolean, back: string, away: boolean): Html {
  const r = rows[at]!;
  const n = r.issue.number;
  const numbers = rows.map((x) => x.issue.number);
  const up = stepTo(numbers, at, -1);
  const down = stepTo(numbers, at, 1);
  const controls = writer
    ? html`${at > 0 || away ? move(base, n, "top", "Top", "t", back) : null}${away
        ? null
        : html`${up === undefined ? null : move(base, n, up, "Up", "u", back)}${down === undefined
            ? null
            : move(base, n, down, "Down", "d", back)}${move(base, n, "not-now", "Not now", "n", back)}`}`
    : null;
  return row({
    href: `${base}/issues/${n}`,
    title: r.issue.title,
    titleAttr: r.issue.title,
    lead: html`${r.place === null ? "·" : String(r.place)}`,
    meta: html`${badge(r.role === "blocker" ? "Blocker" : "Enabler", { variant: r.role === "blocker" ? "secondary" : "outline" })}
      #${n} · ${r.roleWhy}${r.onIt === null ? "" : ` · on it: ${r.onIt}`}${r.why === null ? "" : ` · ${r.why}`}`,
    nav: true,
    data: { number: String(n) },
    ...(controls === null ? {} : { after: controls }),
  });
}

export function nextPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const base = repoBase(repo);
  const all = ctx.url.searchParams.get("all") === "1";
  const writer = ctx.auth.user !== undefined && ctx.auth.user.kind !== "agent" && canWrite(ctx.app.db, repo, ctx.auth.user);
  const next = nextUp(ctx.app.db, repo, sealedScope(ctx.app.db, repo, ctx.auth.user));
  const shown = all ? next.rows : next.rows.slice(0, TOP);
  const rest = next.rows.length - shown.length;
  const back = all ? `${base}/next?all=1` : `${base}/next`;
  const rendering = performance.now();
  const body = html`${repoHeader(ctx, repo, "issues")}
    <div class="page-head mt">
      <h1>Next up</h1>
      <p class="muted">
        The crew builds strictly from the top.
        ${writer
          ? "Drag a row, or press the key beside an action on the row you are on (j and k move between rows): each saves at once."
          : "Only someone who writes here can change the order."}
        Dependencies order work within the list; they are shown, not edited.
      </p>
    </div>
    <p class="error" id="next-flash" role="alert" hidden></p>
    ${next.rows.length === 0
      ? html`<p class="muted">Nothing is ready: everything open waits for something. <a href="${base}/map">See the map</a>.</p>`
      : card(
          html`<ul class="list setting-list" id="next-list">
            ${shown.map((_, at) => line(base, next.rows, at, writer, back, false))}
          </ul>`,
          { pad: false },
        )}
    ${all
      ? null
      : rest > 0 || next.notNowTotal > 0
        ? html`<p class="mt">
            <a href="${base}/next?all=1">${[
              rest > 0 ? `${rest} more ready` : null,
              next.notNowTotal > 0 ? `${next.notNowTotal} not now` : null,
            ]
              .filter((x) => x !== null)
              .join(" · ")}: open the rest</a>
          </p>`
        : null}
    ${all && next.notNow.length > 0
      ? html`<section class="stack-tight mt">
          <h2>Not now</h2>
          <p class="muted small">Behind the Later gate. Top lifts one past it in one action.</p>
          ${card(
            html`<ul class="list setting-list">
              ${next.notNow.map((_, at) => line(base, next.notNow, at, writer, back, true))}
            </ul>`,
            { pad: false },
          )}
        </section>`
      : null}`;
  const response = page({
    ctx,
    title: `Next up · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    ...(writer ? { scriptJs: KEYS_JS } : {}),
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** POST /:owner/:name/next — `number` and `to` (`top`, `not-now`, `after:<number>`): one move, saved at once. */
export async function nextSubmit(ctx: Ctx): Promise<Response> {
  const repo: Repo | undefined = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = backTo(form, `${repoBase(repo)}/next`);
  const place: Place | undefined = placeOf(field(form, "to"));
  const number = /^[1-9][0-9]{0,8}$/.test(field(form, "number")) ? Number(field(form, "number")) : 0;
  if (place === undefined || number === 0)
    return flashOrJson(ctx, dest, { tone: "danger", message: "Say which issue and where it goes." });
  const moved = rankIssue(ctx.app, ctx.auth.user, repo, number, place);
  if (!moved.ok) {
    if (moved.error.kind === "not_found") return notFoundPage(ctx);
    return flashOrJson(ctx, dest, { tone: "danger", message: moved.error.message });
  }
  return flashOrJson(ctx, dest, { message: rankedWords(number, place) });
}
