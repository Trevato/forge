/**
 * Finding things in the studio: apps first, then the changes and tells that
 * mention the query. The same route as dev's own `/search` (`pages/search.ts`
 * delegates here in studio mode) and the same visibility — `appsOf` is
 * `listReposVisibleTo` underneath, so a signed-out reader sees exactly the
 * public apps a signed-out reader of dev's search would.
 *
 * Bounded, on purpose: one read for the apps (`appsOf`'s own 200-row cap,
 * matched in memory — no per-row query) and one for the changes and tells
 * together (`searchLocalIssues`, one `repo_id IN (...)` query), split by
 * kind after the fact. Nothing here does a per-row query or a git read —
 * that is what keeps a keystroke here as cheap as one in dev's own box.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import type { Repo } from "../../core/repos.ts";
import { cleanQuery, searchLocalIssues, type IssueHit } from "../../core/search.ts";
import type { Ctx } from "../../http/context.ts";
import { pageHead, repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { markMatch } from "../pages/search.ts";
import {
  badge,
  dot,
  empty,
  icon,
  listCard,
  row,
  stateBadge,
  time,
  type Tone,
} from "../ui.ts";
import { appsOf } from "./asks.ts";
import { changeHref, tellHref } from "./nouns.ts";

const APP_LIMIT = 20;
const CHANGE_LIMIT = 20;
const TELL_LIMIT = 20;
/** The raw read behind both: split by kind after, not asked for twice. */
const ISSUE_READ_LIMIT = CHANGE_LIMIT + TELL_LIMIT;

function matchesApp(repo: Repo, needle: string): boolean {
  const q = needle.toLowerCase();
  return (
    repo.name.toLowerCase().includes(q) ||
    repo.ownerName.toLowerCase().includes(q) ||
    repo.description.toLowerCase().includes(q)
  );
}

/** One app row: its name, one clamped line, and whether it is live. No
 * per-row query — `runtime.status` reads what is already in memory. */
function appRow(ctx: Ctx, repo: Repo, record: AppRecord, query: string): Html {
  const runtime = appsRuntime(ctx.app);
  const envs = runtime === undefined ? [] : runtime.status(record);
  const production = envs.find((e) => e.env === "production");
  const state = production?.state ?? "stopped";
  const tone: Tone =
    state === "running" ? "success" : state === "failed" ? "danger" : "default";
  return row({
    href: repoBase(repo),
    nav: true,
    lead: dot(tone),
    title: markMatch(repo.name, query),
    titleAttr: repo.description || repo.name,
    meta: repo.description
      ? markMatch(repo.description, query)
      : html`<span class="muted">No description</span>`,
    trail: badge(
      state === "running" ? "live" : state === "stopped" ? "not running" : state,
      { tone },
    ),
  });
}

type LocalIssueHit = IssueHit & { source: "local" };

/** Where the hit lives, in the studio's own nouns — every hit here is on
 * an app (`appsOf` is what was searched), so the studio's address is the
 * one this page can hand out without ever sending a reader somewhere the
 * page behind it would not. */
function issueHitHref(hit: LocalIssueHit): string {
  const base = `/${hit.repo.owner}/${hit.repo.name}`;
  return hit.kind === "issue"
    ? tellHref(base, hit.number)
    : changeHref(base, hit.number);
}

/** A change or a tell: which app it belongs to, and its own studio link —
 * never the five-word badge (`pullWord`/`tellWord`), which reads git and a
 * run per row and would make a keystroke here as slow as a page of them. */
function issueHitRow(hit: LocalIssueHit, query: string): Html {
  return row({
    href: issueHitHref(hit),
    nav: true,
    lead: icon(hit.kind === "issue" ? "issue" : "pull"),
    title: markMatch(hit.title, query),
    titleAttr: hit.title,
    meta: html`${hit.repo.owner}/${hit.repo.name} · updated
    ${time(hit.updatedAt)}`,
    trail: stateBadge(hit.state),
  });
}

function section(
  title: string,
  emptyIcon: Parameters<typeof icon>[0],
  rows: Html[],
  emptyText: string,
): Html {
  return html`<h2 class="mt">${title}</h2>
    ${rows.length === 0
      ? html`<p class="no-hits muted small">
          ${icon(emptyIcon)}<span>${emptyText}</span>
        </p>`
      : listCard(rows)}`;
}

/**
 * GET /search in the studio: apps first, then every change and tell whose
 * title mentions the query, each saying which app it belongs to. An empty
 * or overlong query is simply an empty result — `cleanQuery` is the same
 * boundary dev's search enforces.
 */
export function studioSearchPage(ctx: Ctx): Response {
  const query = cleanQuery(ctx.url.searchParams.get("q") ?? "");

  const form = html`<form
    class="filters"
    method="get"
    action="/search"
    role="search"
  >
    <input
      class="input search"
      type="search"
      name="q"
      value="${query}"
      placeholder="Search your apps, changes and tells"
      aria-label="Search"
      autofocus
      data-search-input
    />
    <button class="btn" data-variant="primary" data-size="sm" type="submit">
      Search
    </button>
  </form>`;

  if (query === "") {
    return page({
      ctx,
      title: "Studio search",
      body: html`${pageHead("Search")} ${form}
      ${empty({
        icon: "search",
        title: "Search your studio",
        note: "An app's name or description, or a word from what was told or changed.",
      })}`,
    });
  }

  const { repos, records } = appsOf(ctx, ctx.auth.user);
  const apps = repos.filter((r) => matchesApp(r, query)).slice(0, APP_LIMIT);

  const issueHits = searchLocalIssues(
    ctx.app.db,
    repos,
    query,
    ISSUE_READ_LIMIT,
  ).filter((h): h is LocalIssueHit => h.source === "local");
  const changes = issueHits
    .filter((h) => h.kind === "pull")
    .slice(0, CHANGE_LIMIT);
  const tells = issueHits
    .filter((h) => h.kind === "issue")
    .slice(0, TELL_LIMIT);

  const body = html`${pageHead(html`Results for “${query}”`)} ${form}
  ${section(
    "Apps",
    "rocket",
    apps.map((r) => appRow(ctx, r, records.get(r.id)!, query)),
    "No app matches",
  )}
  ${section(
    "Changes",
    "pull",
    changes.map((h) => issueHitRow(h, query)),
    "No change matches",
  )}
  ${section(
    "Tells",
    "issue",
    tells.map((h) => issueHitRow(h, query)),
    "No tell matches",
  )}
  ${when(
    apps.length === 0 && changes.length === 0 && tells.length === 0,
    () =>
      html`<p class="muted small mt">
        Nothing matched — try a different word.
      </p>`,
  )}`;

  return page({
    ctx,
    title: `Studio search · ${query}`,
    body,
  });
}
