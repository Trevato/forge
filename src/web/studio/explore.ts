/**
 * `/explore` (#607): the apps, people and forges the viewer can see, ranked
 * by real numbers and shown with them, narrowed in one line that lives in
 * the URL (`?q=kind:app sort:forks garden`). Every app row says "Make it
 * yours" (#606): a plan of the copy, then the app as theirs. Decided in
 * `actions/explore.ts`; this page only draws it.
 */

import {
  explorePage as readPage,
  exploreLine,
  exploreCount,
  exploreFiltered,
  exploreLineFrom,
  exploreParams,
  exploreNote,
  exploreSuggestion,
  MAKE_IT_YOURS,
  whyOf,
  readExploreLine,
  type ExploreQuery,
  type ExploreRow,
  type WhySignal,
} from "../../actions/explore.ts";
import { frontWeights, type FrontWeights } from "../../core/front.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { activeEdgeToken, edgeLoginUrl } from "../../http/edge.ts";
import { offersSignup, pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, empty, nameMark, row as rowOf, seg, tabs, time } from "../ui.ts";

const href = (query: ExploreQuery): string => {
  const params = exploreParams(query);
  return params === "" ? "/explore" : `/explore?${params}`;
};

/**
 * A row's numbers as a person reads them; nothing that is zero. Hours awake
 * are not among them: summed over every copy of an app, previews too, they
 * read as a figure ("3085.9 h") that says nothing to a visitor. They still
 * weigh in the ranking (`core/front.ts`).
 */
function numbers(row: ExploreRow, said: WhySignal | undefined): { apps: string; rest: Html } {
  const n = row.numbers;
  // What the row's reason already says is not said again beside it.
  const rest = [
    n.forks > 0 && said !== "forks" ? `${n.forks} fork${n.forks === 1 ? "" : "s"}` : "",
    n.likes > 0 && said !== "likes" ? `${n.likes} like${n.likes === 1 ? "" : "s"}` : "",
    n.ships > 0 && said !== "ships" ? `${n.ships} shipped this month` : "",
  ];
  const shipped = row.shippedAt === null || said === "fresh" ? null : html`shipped ${time(row.shippedAt)}`;
  const restText = rest.filter((p) => p !== "").map((p) => html`${p}`);
  if (shipped !== null) restText.push(shipped);
  return {
    apps: row.kind === "person" ? `${n.apps} app${n.apps === 1 ? "" : "s"}` : "",
    rest: restText.reduce((all, p, i) => (i === 0 ? p : html`${all} · ${p}`), html``),
  };
}

function rowHtml(row: ExploreRow, signedIn: boolean, query: ExploreQuery, now: number, weights: FrontWeights): Html {
  const why = whyOf(row, query.sort, now, weights);
  const { apps, rest } = numbers(row, why?.signal);
  // One tap from a person to their apps; with none, the count is plain text.
  const theirs = href({ kind: "app", sort: "score", text: "", archived: false, updated: "all", owner: row.name });
  const count = apps === "" ? html`` : row.numbers.apps > 0 ? html`<a href="${theirs}">${apps}</a>` : html`${apps}`;
  const parts = [
    why === undefined ? html`` : why.signal === "fresh" && row.shippedAt !== null ? html`shipped ${time(row.shippedAt)}` : html`${why.text}`,
    row.description === "" ? html`` : html`${row.description}`,
    count,
    rest,
  ].filter((p) => p.toString() !== "");
  const metaHtml = parts.reduce((all, p, i) => (i === 0 ? p : html`${all} · ${p}`), html``);
  return rowOf({
    title: html`<a href="${row.url}">${row.name}</a>${nameMark(row.mark)}`,
    ...(parts.length === 0 ? {} : { meta: metaHtml }),
    ...(row.copyable === true && row.repo !== undefined
      ? {
          trail: signedIn
            ? html`<form method="post" action="/${row.repo.owner}/${row.repo.name}/make-it-yours" data-make-it-yours>
                <input type="hidden" name="receipt" value="1" />
                ${btn(MAKE_IT_YOURS.label, { size: "sm", icon: "fork" })}
              </form>`
            : btn(MAKE_IT_YOURS.label, {
                href: `/${row.repo.owner}/${row.repo.name}/make-it-yours?receipt=1`,
                size: "sm",
                icon: "fork",
              }),
        }
      : {}),
  });
}

/** A button label that cannot push the page wider; the whole term is its title. */
const shorten = (term: string): string =>
  term.length > 24 ? `${term.slice(0, 23)}…` : term;

/** Each term of a missed line, with the query that is the line without it. */
function terms(query: ExploreQuery): { term: string; without: ExploreQuery }[] {
  const out: { term: string; without: ExploreQuery }[] = [];
  if (query.kind !== "all")
    out.push({ term: `kind:${query.kind}`, without: { ...query, kind: "all" } });
  if (query.sort !== "score")
    out.push({ term: `sort:${query.sort}`, without: { ...query, sort: "score" } });
  if (query.archived)
    out.push({ term: "archived:yes", without: { ...query, archived: false } });
  if (query.updated !== "all")
    out.push({ term: `updated:${query.updated}`, without: { ...query, updated: "all" } });
  const words = query.text.split(/\s+/).filter((w) => w !== "");
  words.forEach((word, i) =>
    out.push({
      term: word,
      without: { ...query, text: words.filter((_, j) => j !== i).join(" ") },
    }),
  );
  return out;
}

/** Nothing to list: a bare line means nothing is public yet, not a miss. */
function emptyState(ctx: Ctx, query: ExploreQuery): Html {
  const line = exploreLine(query);
  if (line !== "")
    return empty({
      icon: "search",
      title: `Nothing matches ${line}`,
      note: "Drop a term to step back:",
      action: html`<div class="form-actions">
        ${terms(query).map(
          (t) => btn(shorten(t.term), { href: href(t.without), size: "sm", title: `Drop ${t.term}` }),
        )}
        ${btn("Clear all", { href: "/explore", size: "sm" })}
      </div>`,
    });
  return empty({
    icon: "search",
    title: "Nothing public yet",
    note: "Make the first app and it shows up here.",
    action:
      ctx.auth.user !== undefined
        ? btn("Make an app", { href: "/apps/new", variant: "primary" })
        : offersSignup(ctx)
          ? html`${btn("Create an account", { href: "/signup?next=/apps/new", variant: "primary" })}
            ${btn("Sign in", { href: "/signin?next=/apps/new" })}`
          : btn("Sign in", { href: activeEdgeToken(ctx.app) === undefined ? "/signin?next=/apps/new" : edgeLoginUrl("/apps/new"), variant: "primary" }),
  });
}

/** What the filter's terms are, for a link that takes one away: the owner too, which `terms` leaves to the line. */
function removable(query: ExploreQuery): { term: string; without: ExploreQuery }[] {
  const out = terms(query).filter((t) => !t.term.startsWith("sort:"));
  if (query.owner !== undefined) {
    const { owner: _owner, ...rest } = query;
    out.push({ term: `owner:${query.owner}`, without: rest });
  }
  return out;
}

/**
 * How much is left, and the way back. A fixed-height line, so the list never
 * moves. Unfiltered and empty it is silent: "Nothing public yet" says it.
 * A miss names each filter that can be dropped, beside Clear filters.
 */
function countLine(query: ExploreQuery, total: number): Html {
  const on = exploreFiltered(query);
  if (total === 0 && !on) return html``;
  const drops =
    total === 0
      ? removable(query).map((t) => html` · <a href="${href(t.without)}">Drop ${shorten(t.term)}</a>`)
      : [];
  return html`<span class="muted" role="status" data-hits>${exploreCount(query, total)}${drops}${
    on ? html` · <a href="/explore" data-clear-filters>Clear filters</a>` : html``
  }</span>`;
}

// GET /explore
export async function explorePage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const line = exploreLineFrom((name) => ctx.url.searchParams.get(name));
  const { query, unknown } = readExploreLine(line);
  const note = exploreNote(unknown);
  const suggestion = exploreSuggestion(line);
  const ranking = performance.now();
  // A cursor that is not one for this query (junk, over-long, another sort) shows the first page.
  const asked = ctx.url.searchParams.get("cursor");
  const after = asked === null ? null : await readPage(ctx.app, ctx.auth.user, query, asked);
  const returned = asked !== null && after === null;
  const page0 = after ?? (await readPage(ctx.app, ctx.auth.user, query, null));
  const here = href(query);
  const rows = page0?.items ?? [];
  const more = page0?.nextCursor ?? null;
  const weights = frontWeights(ctx.app.db);
  notePhase(ctx.request, "read", performance.now() - ranking);
  const rendering = performance.now();
  const now = Date.now();
  const kinds = [
    { label: "All", kind: "all" as const },
    { label: "Apps", kind: "app" as const },
    { label: "People", kind: "person" as const },
    // Forges are a site admin's to see (explore.ts in actions): no chip onto an empty page.
    ...(ctx.auth.user?.isAdmin === true
      ? [{ label: "Forges", kind: "forge" as const }]
      : []),
  ];
  const sorts = [
    { label: "Best", sort: "score" as const },
    { label: "Forks", sort: "forks" as const },
    { label: "Shipped", sort: "ships" as const },
    { label: "Liked", sort: "likes" as const },
    { label: "Use", sort: "use" as const },
    { label: "Fresh", sort: "fresh" as const },
  ];
  const windows = [
    { label: "Any time", updated: "all" as const },
    { label: "Today", updated: "1d" as const },
    { label: "This week", updated: "7d" as const },
    { label: "This month", updated: "30d" as const },
  ];
  const body = html`<div data-explore>${pageHead("Explore", {
      sub: "Apps and their makers, ranked by forks, ships, use and recency.",
    })}
    <form method="get" action="/explore" class="bar mb">
      <input
        type="search"
        class="input mono"
        name="q"
        value="${exploreLine(query)}"
        placeholder="kind:app sort:forks garden"
        aria-label="Narrow the list"
        autocomplete="off"
        spellcheck="false"
      />
      ${btn("Go", { size: "sm" })}
    </form>
    ${returned ? html`<p class="muted mb" role="status">That page link is not one for this list, so this is the first page.</p>` : html``}
    ${note === "" ? html`` : html`<p class="muted mb" role="status">${note}${
          suggestion === undefined
            ? html``
            : html` Did you mean <a href="${href(readExploreLine(suggestion.line).query)}">${suggestion.fix}</a>?`
        }</p>`}
    <div class="mb">
      ${tabs(
        kinds.map((k) => ({
          label: k.label,
          href: href({ ...query, kind: k.kind }),
          current: query.kind === k.kind,
        })),
        "Kind",
      )}
    </div>
    <div class="bar mb small">
      ${seg(
        sorts.map((s) => ({
          label: s.label,
          href: href({ ...query, sort: s.sort }),
          current: query.sort === s.sort,
        })),
      )}
      ${seg(
        windows.map((w) => ({
          label: w.label,
          href: href({ ...query, updated: w.updated }),
          current: query.updated === w.updated,
        })),
      )}
      <a
        class="muted home-doors"
        href="${href({ ...query, archived: !query.archived })}"
        aria-pressed="${query.archived ? "true" : "false"}"
        >Show archived</a
      >
      ${countLine(query, page0?.total ?? 0)}
    </div>
    ${rows.length === 0
      ? emptyState(ctx, query)
      : card(html`<ul class="list">${rows.map((r) => rowHtml(r, ctx.auth.user !== undefined, query, now, weights))}</ul>`, {
          pad: false,
          extra: "bare",
        })}${more === null
        ? html``
        : html`<div class="explore-more">${btn("More results", { href: `${here}${here.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(more)}`, variant: "outline", extra: "explore-more-link" })}</div>`}</div>`;
  const drawn = page({ ctx, title: "Explore", body, feed: { href: "/explore.atom", title: "Explore" } });
  // An unknown filter is a 400 here as on the API and the MCP; the page still draws the note and the results.
  const response = unknown.length === 0 ? drawn : new Response(drawn.body, { status: 400, headers: drawn.headers });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
