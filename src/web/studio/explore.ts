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
  parseExploreQuery,
  type ExploreQuery,
  type ExploreRow,
} from "../../actions/explore.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { pageHead } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, empty, listCard, nameMark, seg, timeAgo } from "../ui.ts";

const href = (query: ExploreQuery): string => {
  const line = exploreLine(query);
  return line === "" ? "/explore" : `/explore?q=${encodeURIComponent(line)}`;
};

/** A row's numbers as a person reads them; nothing that is zero. */
function numbers(row: ExploreRow): string {
  const n = row.numbers;
  const parts = [
    row.kind === "person" ? `${n.apps} app${n.apps === 1 ? "" : "s"}` : "",
    n.forks > 0 ? `${n.forks} fork${n.forks === 1 ? "" : "s"}` : "",
    n.ships > 0 ? `${n.ships} shipped this month` : "",
    n.awakeHours > 0 ? `${n.awakeHours} h in use` : "",
    row.shippedAt !== null ? `last shipped ${timeAgo(row.shippedAt)}` : "",
  ];
  return parts.filter((p) => p !== "").join(" · ");
}

function rowHtml(row: ExploreRow): Html {
  const said = numbers(row);
  return html`<li class="row explore-row">
    <span class="explore-main">
      <a class="explore-name" href="${row.url}">${row.name}</a
      >${nameMark(row.mark)}
      ${when(
        row.description,
        (d) => html`<span class="muted small truncate">${d}</span>`,
      )}
      ${when(said, (s) => html`<span class="muted small">${s}</span>`)}
    </span>
    ${when(
      row.copyable === true ? row.repo : undefined,
      (repo) =>
        btn("Make it yours", {
          href: `/${repo.owner}/${repo.name}/make-it-yours`,
          size: "sm",
          icon: "fork",
        }),
    )}
  </li>`;
}

// GET /explore
export async function explorePage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const query = parseExploreQuery(ctx.url.searchParams.get("q") ?? "");
  const ranking = performance.now();
  const rows = await explore(ctx.app, ctx.auth.user, query);
  notePhase(ctx.request, "rank", performance.now() - ranking);
  const rendering = performance.now();
  const kinds = [
    { label: "All", kind: "all" as const },
    { label: "Apps", kind: "app" as const },
    { label: "People", kind: "person" as const },
    ...(ctx.auth.user?.isAdmin === true
      ? [{ label: "Forges", kind: "forge" as const }]
      : []),
  ];
  const sorts = [
    { label: "Best", sort: "score" as const },
    { label: "Forks", sort: "forks" as const },
    { label: "Shipped", sort: "ships" as const },
    { label: "Use", sort: "use" as const },
    { label: "Fresh", sort: "fresh" as const },
  ];
  const body = html`${pageHead("Explore", {
      sub: "Apps and their makers, ranked by forks, ships, use and how lately — the numbers on every row.",
    })}
    <form method="get" action="/explore" class="bar mb explore-line">
      <input
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
    <div class="filters mb explore-filters">
      ${seg(
        kinds.map((k) => ({
          label: k.label,
          href: href({ ...query, kind: k.kind }),
          current: query.kind === k.kind,
        })),
      )}
      ${seg(
        sorts.map((s) => ({
          label: s.label,
          href: href({ ...query, sort: s.sort }),
          current: query.sort === s.sort,
        })),
      )}
      <a
        class="btn" data-size="sm"
        href="${href({ ...query, archived: !query.archived })}"
        aria-pressed="${query.archived ? "true" : "false"}"
        >Show archived</a
      >
    </div>
    ${rows.length === 0
      ? empty({
          icon: "search",
          title: "Nothing matches",
          note: "Clear the line to see everything you can.",
        })
      : listCard(rows.map(rowHtml))}`;
  const response = page({ ctx, title: "Explore", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
