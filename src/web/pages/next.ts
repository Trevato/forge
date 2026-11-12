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
import { openPullStages } from "../../flow/read.ts";
import { stateWord, type StateFacts } from "./next_state.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { sealedScope } from "../../core/sealed.ts";
import { notStartable } from "../../crew/not_startable.ts";
import { CUT_TOP_WORDS, cutWords, FIT_COUNT_JS, rangeWords, rowCosts, weekView, type Cut, type Priced } from "../../flow/week.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { backTo, field, readForm } from "../form.ts";
import { html, raw, type Html } from "../html.ts";
import { flashOrJson, page } from "../layout.ts";
import { btn, kbd, row } from "../ui.ts";

/**
 * The owner's issue titles are their own words, so inside `[data-next]` a long
 * word breaks anywhere, and a row's actions drop under its text (the row asks
 * for 14rem, not 0) in place of squeezing the title to a sliver at 390 px.
 * The lists sit straight on the page and are spaced, not ruled (DESIGN.md §1,
 * principles 3 and 7): no hairline between rows, a small gap instead.
 * No new class.
 */
export const NEXT_CSS = `[data-next] { overflow-wrap: anywhere; }
[data-next] .list { display: flex; flex-direction: column; gap: 4px; padding: 0; margin: 0; }
[data-next] .list > li + li { border-top: 0; }
[data-next] .list .row { border-radius: var(--radius); }
[data-next] .list > li.has-after > .row { flex: 1 1 14rem; }
[data-next] .row-after { display: flex; flex-wrap: wrap; gap: 6px; max-width: 100%; padding: 0 14px 8px; }
[data-next] summary h2 { display: inline; margin: 0; }
[data-next] .cut-line { overflow-wrap: anywhere; }`;

export const KEYS_JS = `
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
      return false;
    }
    sessionStorage.setItem("next-focus", number);
    location.reload();
    return true;
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
  ${FIT_COUNT_JS}
  const usd = list.dataset.capacity === undefined ? NaN : Number(list.dataset.capacity);
  const numbered = () => [...list.querySelectorAll("li[data-number]")];
  // Re-place the cut line from the rows' costs in their current order; while dragging, rows below it read as next week.
  const place = (dragging) => {
    if (!(usd >= 0)) return;
    const rows = numbered();
    const n = fitCount(rows.map((r) => Number(r.dataset.cost)), usd);
    let mark = list.querySelector(".cut-line");
    if (n >= rows.length) { if (mark) mark.remove(); }
    else {
      if (!mark) { mark = document.createElement("li"); mark.className = "cut-line"; mark.setAttribute("role", "separator"); }
      mark.textContent = n === 0 ? ${JSON.stringify(CUT_TOP_WORDS)} : ${JSON.stringify(cutWords("{n}"))}.replace("{n}", n);
      list.insertBefore(mark, rows[n]);
    }
    rows.forEach((r, i) => r.classList.toggle("next-week", dragging && i >= n));
  };
  let held = null;
  let origin = [];
  let dropped = false;
  const restore = () => {
    origin.forEach((r) => list.appendChild(r));
    place(false);
  };
  list.querySelectorAll("li[data-number]").forEach((li) => { li.draggable = true; });
  list.addEventListener("dragstart", (e) => {
    held = e.target.closest("li[data-number]");
    origin = numbered();
    dropped = false;
  });
  list.addEventListener("dragover", (e) => {
    if (!held) return;
    e.preventDefault();
    const over = e.target.closest("li[data-number]");
    if (!over || over === held) return;
    const rows = numbered();
    list.insertBefore(held, rows.indexOf(over) > rows.indexOf(held) ? over.nextSibling : over);
    place(true);
  });
  list.addEventListener("dragend", () => {
    if (!dropped) restore();
    list.querySelectorAll(".next-week").forEach((r) => r.classList.remove("next-week"));
    held = null;
  });
  list.addEventListener("drop", async (e) => {
    if (!held) return;
    e.preventDefault();
    const rows = numbered();
    const at = rows.indexOf(held);
    if (at === origin.indexOf(held)) { restore(); return; }
    dropped = true;
    const before = at === 0 ? "top" : "after:" + rows[at - 1].dataset.number;
    const number = held.dataset.number;
    // On success the dragged order stays until the reload; only a refusal puts the rows back.
    if (!(await send({ number, to: before }, number))) restore();
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

function line(
  base: string,
  rows: readonly NextRow[],
  at: number,
  writer: boolean,
  back: string,
  away: boolean,
  priced: readonly Priced[] = [],
  cost: number | undefined = undefined,
  position: number | null = null,
  state: string | null = null,
): Html {
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
    lead: html`${position === null ? "·" : String(position)}`,
    meta: html`${r.role === "blocker" ? "Blocker" : "Enabler"} · #${n}${state === null ? "" : ` · ${state} · ${r.onIt ?? "next"}`} · ${r.roleWhy}${away ? null : html` · <span class="estimate">${rangeWords(priced.find((p) => p.number === n)?.estimate ?? { known: false, samples: 0, basis: "no estimate" })}</span>`}${state !== null || r.onIt === null ? "" : ` · on it: ${r.onIt}`}${r.why === null ? "" : ` · ${r.why}`}`,
    nav: true,
    data: { number: String(n), ...(cost === undefined ? {} : { cost: String(cost) }) },
    ...(controls === null ? {} : { after: controls }),
  });
}

/** The cut line: everything above it fits this week's capacity, everything below reads as next week. */
function cutMark(cut: Cut, top: boolean): Html {
  return html`<li class="cut-line" role="separator">${top
    ? CUT_TOP_WORDS
    : cutWords(cut.fits.length)}</li>`;
}

export function nextPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const base = repoBase(repo);
  const writer = ctx.auth.user !== undefined && ctx.auth.user.kind !== "agent" && canWrite(ctx.app.db, repo, ctx.auth.user);
  const scope = sealedScope(ctx.app.db, repo, ctx.auth.user);
  const next = nextUp(ctx.app.db, repo, scope, (ready) => notStartable(ctx.app, repo, ready, scope));
  const rows = next.rows;
  const back = `${base}/next`;
  const rendering = performance.now();
  const { priced, cut, capacity, sentence } = weekView(ctx.app.db, repo.id, rows, new Date());
  const costs = rowCosts(priced);
  const stages = openPullStages(ctx.app.db, repo, scope, new Date(), new Set(rows.map((r) => r.issue.number)));
  const facts = (r: NextRow): StateFacts => ({ stage: stages.get(r.issue.number) ?? "issue", waits: r.waits, held: r.state === "held", onIt: r.onIt !== null });
  // One numbered order, folded: the first TOP rows open, what comes after, then Later.
  const first = rows.slice(0, TOP);
  const after = rows.slice(TOP);
  const section = (title: string, list: readonly NextRow[], start: number, open: boolean, id?: string): Html =>
    html`<details class="mt"${open ? raw(" open") : null}><summary><h2>${title} · ${String(list.length)}</h2></summary>
      <ul class="list setting-list"${id === undefined ? null : html` id="${id}"`}${id !== undefined && costs !== null && capacity !== null && cut.unsure === null ? html` data-capacity="${String(capacity.usd)}"` : null}>
        ${list.flatMap((_, i) => {
          const at = start + i;
          const mark = at === cut.fits.length && cut.unsure === null && id !== undefined && i > 0 ? [cutMark(cut, false)] : [];
          return [...mark, line(base, rows, at, writer, back, false, priced, costs?.[at], at + 1, stateWord(rows[at]!, facts(rows[at]!)))];
        })}
      </ul></details>`;
  const body = html`${repoHeader(ctx, repo, "issues")}
    <div data-next>
    ${pageHead("Next up", { sub: "The crew builds strictly from the top." })}
    <p class="error" id="next-flash" role="alert" hidden></p>
    ${rows.length === 0
      ? html`<p class="muted">Nothing is ready: everything open waits for something. <a href="${base}/map">See the map</a>.</p>`
      : html`${section("Up next", first, 0, true, "next-list")}${after.length > 0 ? section("After", after, TOP, false) : null}`}
    <p class="muted small mt" id="next-week">${sentence} <a href="${base}/week">The week</a>${writer
      ? " · Drag a row, or press the key on its button; j and k move between rows."
      : null}</p>
    ${next.notNow.length > 0
      ? html`<details class="mt"><summary><h2>Later · ${String(next.notNowTotal)}</h2></summary><ul class="list setting-list">
            ${next.notNow.map((_, at) => line(base, next.notNow, at, writer, back, true))}
          </ul></details>`
      : null}
    ${next.unlisted > 0
      ? html`<p class="muted small mt">${String(next.unlisted)} more open issues are not listed here; the queue API pages through them.</p>`
      : null}
    </div>`;
  const response = page({
    ctx,
    title: `Next up · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: NEXT_CSS,
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
