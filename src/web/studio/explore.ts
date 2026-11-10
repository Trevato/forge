/**
 * `/explore` (#607): the apps, people and forges the viewer can see, ranked
 * by real numbers and shown with them, narrowed in one line that lives in
 * the URL (`?q=kind:app sort:forks garden`). Every app row says "Make it
 * yours" (#606): a plan of the copy, then the app as theirs. Decided in
 * `actions/explore.ts`; this page only draws it.
 */

import {
  explore,
  exploreLine,
  exploreNote,
  exploreSuggestion,
  readExploreLine,
  type ExploreQuery,
  type ExploreRow,
} from "../../actions/explore.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { activeEdgeToken, edgeLoginUrl } from "../../http/edge.ts";
import { offersSignup, pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, empty, nameMark, row as rowOf, seg, tabs, timeAgo } from "../ui.ts";

const href = (query: ExploreQuery): string => {
  const line = exploreLine(query);
  return line === "" ? "/explore" : `/explore?q=${encodeURIComponent(line)}`;
};

/**
 * A row's numbers as a person reads them; nothing that is zero. Hours awake
 * are not among them: summed over every copy of an app, previews too, they
 * read as a figure ("3085.9 h") that says nothing to a visitor. They still
 * weigh in the ranking (`core/front.ts`).
 */
function numbers(row: ExploreRow): { apps: string; rest: string } {
  const n = row.numbers;
  const rest = [
    n.forks > 0 ? `${n.forks} fork${n.forks === 1 ? "" : "s"}` : "",
    n.likes > 0 ? `${n.likes} like${n.likes === 1 ? "" : "s"}` : "",
    n.ships > 0 ? `${n.ships} shipped this month` : "",
    row.shippedAt !== null ? `last shipped ${timeAgo(row.shippedAt)}` : "",
  ];
  return {
    apps: row.kind === "person" ? `${n.apps} app${n.apps === 1 ? "" : "s"}` : "",
    rest: rest.filter((p) => p !== "").join(" · "),
  };
}

function rowHtml(row: ExploreRow, signedIn: boolean): Html {
  const { apps, rest } = numbers(row);
  // One tap from a person to their apps; with none, the count is plain text.
  const theirs = href({ kind: "app", sort: "score", text: "", archived: false, updated: "all", owner: row.name });
  const count = apps === "" ? html`` : row.numbers.apps > 0 ? html`<a href="${theirs}">${apps}</a>` : html`${apps}`;
  const parts = [
    row.description === "" ? html`` : html`${row.description}`,
    count,
    rest === "" ? html`` : html`${rest}`,
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
                ${btn("Make it yours", { size: "sm", icon: "fork" })}
              </form>`
            : btn("Make it yours", {
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

// GET /explore
export async function explorePage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const line = ctx.url.searchParams.get("q") ?? "";
  const { query, unknown } = readExploreLine(line);
  const note = exploreNote(unknown);
  const suggestion = exploreSuggestion(line);
  const ranking = performance.now();
  const rows = await explore(ctx.app, ctx.auth.user, query);
  notePhase(ctx.request, "rank", performance.now() - ranking);
  const rendering = performance.now();
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
      sub: "Apps and their makers, ranked by forks, ships, use and how lately — the numbers on every row.",
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
    ${note === "" ? html`` : html`<p class="muted mb" role="status">${note}${
          suggestion === undefined
            ? html``
            : html` Did you mean <a href="/explore?q=${encodeURIComponent(suggestion.line)}">${suggestion.fix}</a>?`
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
    </div>
    ${rows.length === 0
      ? emptyState(ctx, query)
      : card(html`<ul class="list">${rows.map((r) => rowHtml(r, ctx.auth.user !== undefined))}</ul>`, {
          pad: false,
          extra: "bare",
        })}</div>`;
  const drawn = page({ ctx, title: "Explore", body });
  // An unknown filter is a 422 here as on the API and the MCP; the page still draws the note and the results.
  const response = unknown.length === 0 ? drawn : new Response(drawn.body, { status: 422, headers: drawn.headers });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
