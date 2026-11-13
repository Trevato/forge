/**
 * The new home's table (`/home?view=table`): every item of every lane, one
 * row each, from the same off-thread picture the lanes read
 * (`flow/lanes.ts`), so it costs the thread no query of its own. Search,
 * filters and sort are links and a plain GET form, held in the URL, so it
 * works without script; the page's script adds instant search, selecting rows
 * and the small action bar. The rows are one live region that swaps itself
 * when an event moves work, like a lane.
 *
 * The actions are the fleet's own (`fleet/verbs.ts`): each is previewed row
 * by row with what would be refused and why, applied through the platform's
 * own action for each row (which authorizes again), and kept as a receipt that
 * can be undone where it can be. Only the ones that are safe over many rows
 * and exist for the kind of row are offered.
 */

import { applyFleetIds, previewFleetIds } from "../../actions/fleet.ts";
import {
  LANES,
  type LanePicture,
} from "../../flow/lanes.ts";
import {
  COLUMNS,
  facets,
  filterRows,
  sortRows,
  tableHref,
  tableParams,
  type Chip,
  type Column,
  type TableQuery,
  type TableRow,
} from "../../flow/lanes_table.ts";
import { span } from "../../flow/pipeline.ts";
import type { Ctx } from "../../http/context.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";

/** The events that can move work between rows: any lane's. */
export const TABLE_LIVE = "issue.*,run.*,pull.*,queue.*,release.*,app.serving";

/** The most rows one bulk action takes. */
const BULK_MAX = 100;

/** What the action bar may offer, and what each is in the fleet's words (`fleet/verbs.ts`). */
export const BULK = {
  close: {
    verb: "close",
    label: "Close",
    kinds: ["issue", "pull"],
    reason: true,
    hint: "Closes without merging; undo opens it again.",
  },
  later: {
    verb: "file",
    value: "later",
    label: "Move to Later",
    kinds: ["issue"],
    reason: false,
    hint: "Puts it behind the Later gate; undo takes it out.",
  },
  ship: {
    verb: "ship",
    label: "Land",
    kinds: ["pull"],
    reason: false,
    hint: "Merges each whose check is green; a merge is not undone.",
  },
  replan: {
    verb: "replan",
    label: "Hand to the planner",
    kinds: ["issue"],
    reason: false,
    hint: "The repository's planner plans it again; undo takes it back.",
  },
} as const;
export type BulkOp = keyof typeof BULK;

const TONE_DOT = {
  stuck: "danger",
  waiting: "attn",
  flowing: "success",
} as const;

function age(iso: string | null, now: number): Html {
  if (iso === null) return html`<span class="muted">—</span>`;
  const at = Date.parse(iso);
  return html`<time class="hf-age" datetime="${new Date(at).toISOString()}"
    >${span(now - at)}</time
  >`;
}

const HEAD: Record<Column, string> = {
  app: "App",
  title: "What",
  lane: "Lane",
  state: "Where it is",
  who: "Who has it",
  time: "In lane",
  age: "Age",
};

function chips(
  label: string,
  list: readonly Chip[],
  noneHref: string | null,
  noneLabel: string,
): Html {
  if (list.length === 0) return html``;
  return html`<div class="tb-chipset" role="group" aria-label="${label}">
    <span class="tb-chiplabel">${label}</span>
    ${noneHref === null
      ? null
      : html`<a
          class="tb-chip"
          href="${noneHref}"
          aria-pressed="${list.some((c) => c.on) ? "false" : "true"}"
          >${noneLabel}</a
        >`}
    ${list.map(
      (c) =>
        html`<a
          class="tb-chip"
          href="${c.href}"
          aria-pressed="${c.on ? "true" : "false"}"
          >${c.label} <span class="tb-chipn num">${String(c.count)}</span></a
        >`,
    )}
  </div>`;
}

function row(r: TableRow, now: number): Html {
  const pickable =
    r.issueId !== null && (r.kind === "issue" || r.kind === "pull");
  return html`<tr class="tb-row" data-key="${r.key}" data-q="${r.haystack}">
    <td class="tb-sel">
      ${pickable
        ? html`<button
            type="button"
            class="tb-pick"
            role="checkbox"
            aria-checked="false"
            data-id="${r.issueId ?? ""}"
            data-kind="${r.kind}"
            aria-label="Select ${r.app} #${String(r.number ?? "")}: ${r.title}"
          ></button>`
        : null}
    </td>
    <td class="tb-app">
      <a href="${r.href}"
        ><span class="tb-appname">${r.app}</span>${r.number === null
          ? null
          : html` <span class="tb-no">#${String(r.number)}</span>`}</a
      >
    </td>
    <td class="tb-what"><a href="${r.href}">${r.title}</a></td>
    <td class="tb-lane">${r.laneName}</td>
    <td class="tb-state">
      <span class="dot" data-tone="${TONE_DOT[r.tone]}"></span
      ><span class="tb-hint">${r.hint}</span>
    </td>
    <td class="tb-who">
      ${r.who === "" ? html`<span class="muted">—</span>` : r.who}
    </td>
    <td class="tb-time num">${age(r.since, now)}</td>
    <td class="tb-age num">${age(r.born, now)}</td>
  </tr>`;
}

/** The rows, their chips and their sort: the one live region of the table view. */
export function tableRegion(
  all: readonly TableRow[],
  q: TableQuery,
  now: number,
): Html {
  const rows = sortRows(filterRows(all, q), q);
  const f = facets(all, q);
  const params = tableParams(q);
  const clear = tableHref({
    ...q,
    q: "",
    lane: null,
    app: null,
    who: null,
    tone: null,
  });
  const sortHref = (c: Column): string =>
    tableHref(q, {
      sort: c,
      dir: q.sort === c && q.dir === "asc" ? "desc" : "asc",
    });
  const filtered =
    q.q !== "" ||
    q.lane !== null ||
    q.app !== null ||
    q.who !== null ||
    q.tone !== null;
  return html`<section
    class="tb-region"
    id="hf-table"
    data-live="${TABLE_LIVE}"
    data-live-src="/live/table${params === "" ? "" : `?${params}`}"
    aria-label="Everything in the pipeline, one row each"
  >
    <div class="tb-chips">
      ${chips("Lane", f.lanes, tableHref({ ...q, lane: null }), "All")}
      ${chips("State", f.tones, tableHref({ ...q, tone: null }), "Any")}
      ${chips("Who", f.who, null, "")} ${chips("App", f.apps, null, "")}
    </div>
    <p class="tb-counts small muted" id="tb-counts">
      ${String(rows.length)} of ${String(all.length)}
      ${all.length === 1 ? "item" : "items"}${filtered
        ? html` · <a href="${clear}">Clear filters</a>`
        : null}.
      Each lane lists its newest few dozen; the lanes count the rest.<span id="tb-typed"></span>
    </p>
    <nav class="tb-sorts" aria-label="Sort by">
      <span class="tb-chiplabel">Sort</span>
      ${COLUMNS.map(
        (c) =>
          html`<a
            class="tb-chip"
            href="${sortHref(c)}"
            aria-pressed="${q.sort === c ? "true" : "false"}"
            >${HEAD[c]}${q.sort === c ? (q.dir === "asc" ? " ↑" : " ↓") : ""}</a
          >`,
      )}
    </nav>
    ${rows.length === 0
      ? html`<p class="tb-empty">
          ${all.length === 0
            ? "Nothing is in the pipeline right now."
            : "Nothing matches."}
        </p>`
      : html`<div class="table-scroll">
          <table class="table tb" data-sortable data-dense>
            <thead>
              <tr>
                <th class="tb-sel">
                  <button
                    type="button"
                    class="tb-pick tb-all"
                    role="checkbox"
                    aria-checked="false"
                    aria-label="Select every row shown"
                  ></button>
                </th>
                ${(
                  [
                    "app",
                    "title",
                    "lane",
                    "state",
                    "who",
                    "time",
                    "age",
                  ] as const
                ).map(
                  (c) =>
                    html`<th
                      class="tb-h-${c}"
                      scope="col"
                      aria-sort="${q.sort === c
                        ? q.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"}"
                    >
                      <a href="${sortHref(c)}">${HEAD[c]}</a>
                    </th>`,
                )}
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => row(r, now))}
            </tbody>
          </table>
        </div>`}
  </section>`;
}

/** The search box, and the action bar the page's script shows while rows are picked: nothing in them is live, so a swap never reaches them. */
export function tableTools(q: TableQuery): Html {
  const actions = Object.entries(BULK).map(([op, a]) => ({
    op,
    label: a.label,
    kinds: a.kinds,
    reason: a.reason,
    hint: a.hint,
  }));
  return html`<form class="tb-search" method="get" action="/home" role="search">
      <input type="hidden" name="view" value="table" />
      ${q.lane === null
        ? null
        : html`<input type="hidden" name="lane" value="${q.lane}" />`}
      ${q.app === null
        ? null
        : html`<input type="hidden" name="app" value="${q.app}" />`}
      ${q.who === null
        ? null
        : html`<input type="hidden" name="who" value="${q.who}" />`}
      ${q.tone === null
        ? null
        : html`<input type="hidden" name="state" value="${q.tone}" />`}
      ${q.sort === "lane"
        ? null
        : html`<input type="hidden" name="sort" value="${q.sort}" /><input
              type="hidden"
              name="dir"
              value="${q.dir}"
            />`}
      <input
        class="input"
        type="search"
        id="tb-q"
        name="q"
        value="${q.q}"
        placeholder="Search the app, the words, who has it"
        aria-label="Search the table"
        autocomplete="off"
      />
      <button class="btn" type="submit">Search</button>
    </form>
    <div
      class="tb-bar"
      id="tb-bar"
      role="region"
      aria-label="Actions on the rows picked"
      data-actions="${JSON.stringify(actions)}"
      hidden
    >
      <div class="tb-barrow">
        <span class="tb-picked" id="tb-picked" aria-live="polite"
          >0 picked</span
        >
        <span class="tb-actions" id="tb-actions"></span>
        <button type="button" class="btn" id="tb-clear">Clear</button>
      </div>
      <div class="tb-note" id="tb-note" role="status"></div>
    </div>`;
}

/** A table region's ETag: what the lanes show, the viewer, the view and the minute (its ages are in minutes). */
export function tableTag(
  picture: LanePicture,
  viewer: string,
  q: TableQuery,
  now: number,
): string {
  const b = picture.builders;
  const lanes = LANES.map(
    (k) => `${picture.versions[k]}:${picture.moved[k]}`,
  ).join(",");
  return Bun.hash(
    `${lanes}|${b.running}/${b.slots}|${viewer}|${tableParams(q)}|${Math.floor(now / 60_000)}`,
  ).toString(36);
}

// ---- the action bar's one route ----

const json = (status: number, body: unknown): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

// POST /home/act — preview (the default) or apply one of `BULK` over rows named by issue id. Answers JSON.
export async function homeActPost(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined)
    return json(401, { ok: false, error: "Sign in to act." });
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const op = field(form, "op");
  const action = Object.hasOwn(BULK, op) ? BULK[op as BulkOp] : undefined;
  if (action === undefined)
    return json(400, {
      ok: false,
      error: `An action is one of ${Object.keys(BULK).join(", ")}.`,
    });
  const ids = [
    ...new Set(
      form
        .getAll("ids")
        .filter((v): v is string => typeof v === "string" && v !== ""),
    ),
  ];
  if (ids.length === 0)
    return json(400, { ok: false, error: "Pick at least one row." });
  if (ids.length > BULK_MAX)
    return json(400, { ok: false, error: `At most ${BULK_MAX} rows at once.` });
  const reason = field(form, "reason").trim();
  const verb = {
    verb: action.verb,
    ...("value" in action
      ? { value: action.value }
      : action.reason && reason !== ""
        ? { value: reason }
        : {}),
  };
  const query = `home: ${ids.length} picked`;
  if (field(form, "phase") !== "apply") {
    const plan = previewFleetIds(ctx.app, user, "issue", ids, query, verb);
    if (!plan.ok)
      return json(plan.error.code === "unauthorized" ? 401 : 422, {
        ok: false,
        error: plan.error.message,
      });
    const c = plan.value.counts;
    const summary = `${action.label} ${plural(plan.value.rows.length, "row", "rows")}: ${c.change} will change${c.unchanged > 0 ? `, ${c.unchanged} already so` : ""}${c.refused > 0 ? `, ${c.refused} refused` : ""}.${plan.value.reversible ? "" : " This cannot be undone."}`;
    return json(200, {
      ok: true,
      phase: "preview",
      summary,
      reversible: plan.value.reversible,
      willChange: c.change,
      refused: plan.value.rows
        .filter((r) => r.outcome === "refused")
        .slice(0, 6)
        .map((r) => ({ label: r.label, why: r.reason })),
    });
  }
  const applied = await applyFleetIds(ctx.app, user, "issue", ids, query, verb);
  if (!applied.ok)
    return json(applied.error.code === "unauthorized" ? 401 : 422, {
      ok: false,
      error: applied.error.message,
    });
  const rows = applied.value.rows;
  const done = rows.filter((r) => r.outcome === "ok").length;
  const refused = rows.filter(
    (r) => r.outcome === "refused" || r.outcome === "failed",
  ).length;
  return json(200, {
    ok: true,
    phase: "apply",
    summary: `${action.label}: ${done} done${refused > 0 ? `, ${refused} not done` : ""}.${applied.value.reversible ? " It can be undone from the receipt." : ""}`,
    receipt: `/fleet/ops/${applied.value.id}`,
    reversible: applied.value.reversible,
  });
}
