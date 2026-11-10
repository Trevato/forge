/**
 * Finding things, and confirming the things you cannot take back.
 *
 * `/search` is the one search, for every viewer, and it needs no script: one
 * query box over every app and repository, tell and change, and line of
 * code the viewer may see, each a section of the same page. `/-/confirm` is the
 * second, deliberate step every destructive POST passes through — and the
 * only page in the product that knows which routes are dangerous, so a
 * crafted link can neither invent reassuring words nor aim at an endpoint
 * that was never meant to be confirmed.
 */

import { DISCONNECT_DETAIL } from "../../actions/origin_words.ts";
import { strangerCodeSearch } from "../../http/strangers.ts";
import { search } from "../../actions/search.ts";
import { envsFor } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import { openLabelCounts } from "../../core/issues.ts";
import { getPull } from "../../core/pulls.ts";
import { canAdmin, canWrite, enterableApps, getRepo } from "../../core/repos.ts";
import { getMirrorTarget } from "../../core/migrate_mirror.ts";
import {
  cleanQuery,
  CODE_BUDGET_MS,
  searchKind,
  type CodeHit,
  type IssueHit,
  type RepoHit,
  type SearchKind,
  type SearchResults,
} from "../../core/search.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { DELETE_REPO, STOP_APP } from "../danger_words.ts";
import { icon } from "../icons.ts";
import { page } from "../layout.ts";
import { browseBase } from "../scope.ts";
import { appsOf } from "../studio/asks.ts";
import { changeHref, tellHref } from "../studio/nouns.ts";
import {
  badge,
  btn,
  dot,
  field as formField,
  repoCounts,
  row,
  seg,
  stateBadge,
  time,
  type Tone,
} from "../ui.ts";

// ---- search ----

/**
 * What a search finds is other people's words (titles, descriptions, paths,
 * lines of code), so inside `[data-search]` a row wraps them and breaks a long
 * word anywhere, in place of the one-line ellipsis; the matching line of code
 * keeps `white-space: pre` and scrolls inside its own box. No new class.
 */
export const SEARCH_CSS = `[data-search] { overflow-wrap: anywhere; }
[data-search] .row-title, [data-search] .row-meta:not(.code-line) { white-space: normal; overflow: visible; text-overflow: clip; }
[data-search] .row { align-items: flex-start; }
[data-search] .row-main { min-width: 0; }
[data-search] .code-line { max-width: 100%; overflow-x: auto; overflow-wrap: normal; }
[data-search] form .input { min-width: 0; }`;

/** What was asked — everything a link back needs. */
interface Asked {
  readonly query: string;
  readonly kind: SearchKind;
  readonly live: boolean;
  /** `?code=all`: grep every repository, not just what fits the budget. */
  readonly codeAll: boolean;
}

/** The apps among what the viewer can see, by id and by `owner/name`. One
 * read for the whole page, never one per row. */
interface Apps {
  readonly byId: ReadonlyMap<string, AppRecord>;
  readonly names: ReadonlySet<string>;
  /** The app ids the viewer may enter (`enterableApps`), read once for the page. */
  readonly enterable: ReadonlySet<string>;
}

/** A section's rows on the page's one background: a heading over rows, no box. */
const rowsUnderHeading = (rows: Html[]): Html =>
  html`<ul class="list">${rows}</ul>`;

const privateBadge = (yes: boolean): Html =>
  when(yes, () => badge("Private", { icon: "lock", variant: "secondary" }));

const archivedBadge = (yes: boolean): Html =>
  when(yes, () => badge("Archived", { variant: "secondary" }));

/** Whether an app is live. No query — `runtime.status` reads what is
 * already in memory. Undefined for a private app the viewer may not enter:
 * its state is its writers' and crew's (`envsFor`), and "not running" would
 * be a guess dressed as a fact. */
function appState(
  ctx: Ctx,
  apps: Apps,
  record: AppRecord,
): { tone: Tone; word: string } | undefined {
  if (!apps.enterable.has(record.id)) return undefined;
  const envs = envsFor(ctx.app, ctx.auth.user, record);
  const state = envs.find((e) => e.env === "production")?.state ?? "stopped";
  const tone: Tone =
    state === "running" ? "success" : state === "failed" ? "danger" : "default";
  const word =
    state === "running" ? "live" : state === "stopped" ? "not running" : state;
  return { tone, word };
}

/**
 * One repository hit, ours or an origin's. An app says whether it is live;
 * any other repository of ours, its open counts; an origin's, whether it is
 * mirrored here — the same glyph the repository pages use for it.
 */
function repoHitRow(ctx: Ctx, apps: Apps, hit: RepoHit): Html {
  const counts = repoCounts({
    openIssues: hit.openIssues,
    openPulls: hit.openPulls,
    ...(hit.source === "origin"
      ? { issuesIncludePulls: hit.openIssuesIncludingPulls }
      : {}),
  });
  const description =
    hit.description === "" ? null : html` · ${hit.description}`;
  if (hit.source === "local") {
    const name = `${hit.owner}/${hit.name}`;
    const record = apps.byId.get(hit.id);
    // A private app's state is its writers' and crew's (`appState`): anyone
    // else gets the counts a plain repository shows.
    const live = record === undefined ? undefined : appState(ctx, apps, record);
    return row({
      href: `/${name}`,
      nav: true,
      lead: live === undefined ? icon("repo") : dot(live.tone),
      title: name,
      titleAttr: hit.description || name,
      meta:
        hit.description === ""
          ? html`<span class="muted">No description</span>`
          : html`${hit.description}`,
      trail: html`${live === undefined
        ? counts
        : badge(live.word, { tone: live.tone })}${privateBadge(
        hit.visibility === "private",
      )}${archivedBadge(hit.archived)}`,
    });
  }
  const mirror = hit.mirroredAs;
  return row({
    href: browseBase(hit.originId, hit.fullName),
    nav: true,
    lead: icon(
      hit.originKind === "github"
        ? "github"
        : hit.originKind === "forgejo"
          ? "forgejo"
          : hit.originKind === "gitea"
            ? "gitea"
            : "globe",
    ),
    title: hit.fullName,
    titleAttr: hit.fullName,
    meta: html`<span
        class="where-place"
        data-state="${mirror === null ? "absent" : "present"}"
        ><span aria-hidden="true"
          >${mirror === null ? "○" : "●"}</span
        >${mirror === null
          ? "not mirrored here"
          : `mirrored as ${mirror.owner}/${mirror.name}`}</span
      >${description}`,
    trail: html`${counts}${privateBadge(hit.private)}`,
  });
}

/** Where a conversation here lives: the studio's noun on an app, so a
 * person is never handed two addresses for one thing; the plain one
 * otherwise. */
function localIssueHref(
  apps: Apps,
  hit: IssueHit & { source: "local" },
): string {
  const base = `/${hit.repo.owner}/${hit.repo.name}`;
  if (apps.names.has(`${hit.repo.owner}/${hit.repo.name}`))
    return hit.kind === "issue"
      ? tellHref(base, hit.number)
      : changeHref(base, hit.number);
  return `${base}/${hit.kind === "issue" ? "issues" : "pulls"}/${hit.number}`;
}

/** One conversation hit. An origin's own goes out to the origin. */
function issueHitRow(apps: Apps, hit: IssueHit): Html {
  const where =
    hit.source === "local"
      ? `${hit.repo.owner}/${hit.repo.name}`
      : hit.fullName;
  return row({
    href:
      hit.source === "local" ? localIssueHref(apps, hit) : hit.htmlUrl,
    nav: true,
    lead: icon(hit.kind === "issue" ? "issue" : "pull"),
    title: hit.title,
    titleAttr: hit.title,
    meta: html`${where} #${hit.number} · updated
    ${time(hit.updatedAt)}${hit.source === "origin"
      ? html` · <span class="muted">on the origin</span>`
      : null}`,
    trail: stateBadge(hit.state),
  });
}

/**
 * The matching line, with the query picked out of it. Both halves go through
 * the `html` tag, so a match inside a file full of markup stays text.
 */
export function markMatch(text: string, query: string): Html {
  const needle = query.toLowerCase();
  if (needle === "") return html`${text}`;
  const hay = text.toLowerCase();
  const parts: Html[] = [];
  let at = 0;
  for (let found = hay.indexOf(needle); found !== -1; ) {
    parts.push(html`${text.slice(at, found)}`);
    parts.push(html`<mark>${text.slice(found, found + needle.length)}</mark>`);
    at = found + needle.length;
    found = hay.indexOf(needle, at);
    if (parts.length > 40) break;
  }
  parts.push(html`${text.slice(at)}`);
  return html`${parts}`;
}

/** One line of code, addressed the way the blob page addresses it. */
function codeHitRow(hit: CodeHit, query: string): Html {
  const at = `/${hit.repo.owner}/${hit.repo.name}`;
  return html`<li>
    <a
      class="row code-hit"
      data-nav
      tabindex="-1"
      href="${at}/blob/HEAD/${hit.path}#L${hit.line}"
    >
      <span class="row-lead">${icon("code")}</span>
      <span class="row-main">
        <span class="row-title mono"
          >${hit.repo.owner}/${hit.repo.name}<span class="muted">/</span
          >${hit.path}<span class="muted">:${hit.line}</span></span
        >
        <span class="row-meta code-line mono"
          >${markMatch(hit.text.trim(), query)}</span
        >
      </span>
      ${when(hit.archived, () => html`<span class="row-trail">${archivedBadge(true)}</span>`)}
    </a>
  </li>`;
}

/** Each kind's words: [kind, chip, heading, nothing found]. */
type Words = readonly [SearchKind, string, string, string];
const WORDS: readonly Words[] = [
  ["all", "All", "", ""],
  [
    "repos",
    "Apps & repos",
    "Apps and repositories",
    "No app or repository matches",
  ],
  [
    "issues",
    "Issues & pull requests",
    "Issues and pull requests",
    "No issue or pull request matches",
  ],
  ["code", "Code", "Code", "No line of code matches"],
];

function searchHref(
  a: Asked,
  over: { kind?: SearchKind; live?: boolean; codeAll?: boolean } = {},
): string {
  const kind = over.kind ?? a.kind;
  const params = new URLSearchParams({ q: a.query });
  if (kind !== "all") params.set("kind", kind);
  if (over.live ?? a.live) params.set("live", "1");
  if (over.codeAll ?? a.codeAll) params.set("code", "all");
  return `/search?${params.toString()}`;
}

function section(
  a: Asked,
  [kind, , title, emptyText]: Words,
  rows: Html[],
  truncated: boolean,
  after: Html | null = null,
): Html {
  return html`<section id="${kind}" aria-labelledby="h-${kind}">
    <h2 class="mt" id="h-${kind}">
      ${title}${rows.length === 0
        ? null
        : html` <span class="muted small num"
            >${rows.length}${truncated ? "+" : ""}</span
          >`}
    </h2>
    ${rows.length === 0
      ? html`<p class="muted">
          ${emptyText}${a.kind === "all"
            ? null
            : html` <a href="${searchHref(a, { kind: "all" })}"
                >Search everything</a
              >`}
        </p>`
      : rowsUnderHeading(rows)}
    ${after}
    ${when(
      truncated,
      () =>
        html`<p class="muted small mt">
          More matched than fit here.
          <a href="${searchHref(a, { kind })}"
            >Show only ${title.toLowerCase()}</a
          >.
        </p>`,
    )}
  </section>`;
}

/** The same `search()` the API and the palette call, so the sources can
 * never disagree between surfaces. */
async function find(
  ctx: Ctx,
  a: Asked,
): Promise<{ found: SearchResults; busy?: number }> {
  // A stranger's code search takes a slot of its own (`http/strangers.ts`);
  // refused, the page still answers with everything but the code, and says so.
  // The same test as the API's: a blank or stop-word query greps nothing.
  const greps =
    ctx.auth.user === undefined &&
    (a.kind === "code" || a.kind === "all") &&
    cleanQuery(a.query) !== "";
  const held = greps
    ? timePhase(ctx.request, "gate", () => strangerCodeSearch(ctx.app, ctx.request))
    : undefined;
  const withCode = held === undefined || held.allowed;
  try {
    const found = await search(ctx.app, ctx.auth.user, {
      q: a.query,
      kind: a.kind,
      live: a.live,
      withCode,
      phase: (name, ms) => notePhase(ctx.request, name, ms),
      ...(a.codeAll
        ? {}
        : { codeBudgetMs: ctx.app.config.codeBudgetMs ?? CODE_BUDGET_MS }),
    });
    return held !== undefined && !held.allowed
      ? { found, busy: held.retryAfter }
      : { found };
  } finally {
    if (held?.allowed) held.release();
  }
}

/**
 * GET /search — everything the viewer can see, in one box, with no script.
 *
 * One page for every viewer: apps and repositories, tells and changes, then code, each a
 * section. The same visibility as everywhere, so a signed-out reader sees
 * exactly the public repositories a signed-out reader would anywhere else.
 *
 * `live=1` is opt-in and stays opt-in: it spends a round trip on every
 * connected origin, which is not a thing to do on every keystroke.
 */
export async function searchPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const params = ctx.url.searchParams;
  const a: Asked = {
    query: cleanQuery(params.get("q") ?? ""),
    kind: searchKind(params.get("kind")),
    live: params.get("live") === "1",
    codeAll: params.get("code") === "all",
  };

  const form = html`<form
    class="bar mb"
    method="get"
    action="/search"
    role="search"
  >
    <input
      class="input"
      type="search"
      name="q"
      value="${a.query}"
      placeholder="Search apps, repositories, issues, pull requests and code"
      aria-label="Search"
      autofocus
      data-search-input
    />
    ${when(
      a.kind !== "all",
      () => html`<input type="hidden" name="kind" value="${a.kind}" />`,
    )}
    ${when(a.live, () => html`<input type="hidden" name="live" value="1" />`)}
    <button class="btn" data-variant="primary" data-size="sm" type="submit">
      Search
    </button>
  </form>`;

  if (a.query === "") {
    const rendering = performance.now();
    const blank = page({
      ctx,
      title: "Search",
      styleCss: SEARCH_CSS,
      body: html`<div data-search data-palette-auto>${pageHead("Search")} ${form}
      <p class="muted">Search this forge: an app or repository by name or description, a word from what was told or changed, or a line of the code itself — across everything you can see, here and on every origin you have connected.</p>
      </div>`,
    });
    notePhase(ctx.request, "render", performance.now() - rendering);
    return blank;
  }

  const { found, busy } = await find(ctx, a);
  const apps: Apps = timePhase(ctx.request, "apps", () => {
    const seen = appsOf(ctx, ctx.auth.user);
    return {
    byId: seen.records,
    names: new Set(seen.repos.map((r) => `${r.ownerName}/${r.name}`)),
    enterable: enterableApps(
      ctx.app.db,
      seen.repos.flatMap((repo) => {
        const app = seen.records.get(repo.id);
        return app === undefined ? [] : [{ repo, app }];
      }),
      ctx.auth.user,
      { named: false },
    ),
    };
  });
  const rendering = performance.now();

  const chips = seg(
    WORDS.map(([kind, label]) => ({
      label,
      href: searchHref(a, { kind }),
      current: kind === a.kind,
    })),
  );

  const liveToggle = when(
    ctx.auth.user !== undefined,
    () =>
      html`<p class="row small muted">
        ${icon("globe")}
        ${a.live
          ? html`<span
              >Asking every connected origin's own search, live.
              <a href="${searchHref(a, { live: false })}">Use the cache</a
              >.</span
            >`
          : html`<span
              >Origins are searched from the cache.
              <a href="${searchHref(a, { live: true })}"
                >Search live on origins</a
              >
              — a round trip to each connected origin, so it costs a
              moment.</span
            >`}
      </p>`,
  );

  const rows: Record<SearchKind, () => [Html[], boolean]> = {
    all: () => [[], false],
    repos: () => [
      found.repos.map((hit) => repoHitRow(ctx, apps, hit)),
      found.truncated.repos,
    ],
    issues: () => [
      found.issues.map((hit) => issueHitRow(apps, hit)),
      found.truncated.issues,
    ],
    code: () => [
      found.code.map((hit) => codeHitRow(hit, a.query)),
      found.truncated.code,
    ],
  };

  const moreCode = when(
    found.moreCode,
    () =>
      html`<p class="muted small mt" data-more-code>
        Code was searched in the first repositories only.
        <a href="${searchHref(a, { codeAll: true })}#code">More code results</a>
      </p>`,
  );

  const nothing =
    a.kind === "all" &&
    found.repos.length + found.issues.length + found.code.length === 0;
  const body = html`<div data-search>${pageHead(html`Results for “${a.query}”`)} ${form}
  <div class="bar mb">${chips}</div>
  ${liveToggle}
  ${when(
    busy !== undefined,
    () =>
      html`<p class="muted small" data-code-busy>
        Code was not searched: code search is busy for visitors who are not
        signed in. <a href="/signin">Sign in</a>, or try again in
        ${String(busy)} s.
      </p>`,
  )}
  ${when(
    found.codeSkipped,
    () =>
      html`<p class="muted small" role="status" data-code-skipped>
        Some code was not searched: the forge is busy grepping. Try again
        shortly.
      </p>`,
  )}
  ${nothing
    ? html`<p class="muted">
        Nothing matches “${a.query}”. Search reads app and repository names
        and descriptions, issues, pull requests and the code you can see.
        <a href="/explore">Explore</a> instead.
      </p>`
    : WORDS
        .filter(
          ([kind]) => kind !== "all" && (a.kind === "all" || a.kind === kind),
        )
        .map((w) =>
          section(a, w, ...rows[w[0]](), w[0] === "code" ? moreCode : null),
        )}</div>`;
  const response = page({ ctx, title: `Search · ${a.query}`, body, styleCss: SEARCH_CSS });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// ---- confirmation ----

interface Destructive {
  verb: string;
  title: string;
  detail: string;
  /** A phrase the visitor must type back before the button will work. */
  phrase: string;
  /** A form value the settings page typed that the confirmed POST needs back. */
  carries?: string;
}

/**
 * The routes this page will confirm, and the words it uses for each. The
 * wording is derived here, never taken from the link — otherwise a mailed
 * URL could put "Continue" on a button that deletes a repository.
 */
const DESTRUCTIVE: {
  pattern: RegExp;
  describe: (m: RegExpMatchArray, ctx: Ctx) => Destructive;
}[] = [
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/delete$/,
    describe: (m) => ({
      verb: DELETE_REPO,
      title: `Delete ${m[1]}/${m[2]}?`,
      detail:
        "Every issue, pull request, comment and webhook goes with it, and the git objects are removed from disk. Forks are detached first and keep working. This cannot be undone.",
      phrase: `${m[1]}/${m[2]}`,
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/transfer$/,
    describe: (m) => ({
      verb: "Move",
      title: `Move ${m[1]}/${m[2]} to another owner?`,
      detail:
        "The repository, its issues and pulls move to the new owner and its address changes; the old address redirects. You must be able to create repositories under the new owner.",
      phrase: "",
      carries: "owner",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/detach$/,
    describe: (m) => ({
      verb: "Detach from parent",
      title: `Detach ${m[1]}/${m[2]} from its parent?`,
      detail:
        "Every object it borrows is copied into its own store and the link is dropped: no updates to take, nothing to propose upstream. Branches, history, issues and pulls stay. There is no undo.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/branches\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete branch",
      title: `Delete ${decodeURIComponent(m[3] ?? "")}?`,
      detail: `The ref goes from ${m[1]}/${m[2]}. Its commits stay in the object store and any pull request already open on it keeps its diff, but nothing points at the branch any more. On a mirror the deletion travels to the origin first, and the local ref moves only if the origin took it.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/app\/domains\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Remove domain",
      title: `Remove ${decodeURIComponent(m[3] ?? "")}?`,
      detail: `The forge stops answering there at once; links to it stop working until the name is added and verified again. ${m[1]}/${m[2]} keeps its own hostname.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/app\/egress\/([^/]+)\/revoke$/,
    describe: (m) => ({
      verb: "Revoke",
      title: `Revoke the app's grant on ${decodeURIComponent(m[3] ?? "")}?`,
      detail: `${m[1]}/${m[2]}'s cells can no longer reach that destination, from their next start. A site admin can grant it again while forge.json still asks for it.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/edge\/unlink$/,
    describe: () => ({
      verb: "Unlink",
      title: "Unlink your open-platform.sh login?",
      detail:
        "You can no longer sign in here through open-platform.sh until you sign in that way and link it again on this page.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/parent\/unlink$/,
    describe: () => ({
      verb: "Unlink",
      title: "Unlink the parent forge?",
      detail:
        "You can no longer sign in here through the parent forge until you link it again on this page. The last way in is never removed.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/proposal-tokens\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Revoke",
      title: "Revoke this proposal token?",
      detail: `The child can no longer push child/<name>/… branches or open pulls on ${m[1]}/${m[2]}. Pulls it already opened stay. A new token has to be minted to let it propose again.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/mirror\/stop$/,
    describe: (m, ctx) => {
      // The mirror's name is read fresh, and only for someone who could
      // stop it, so this page never says where a private repository goes.
      const repo = getRepo(ctx.app.db, m[1]!, m[2]!);
      const held =
        repo && canAdmin(ctx.app.db, repo, ctx.auth.user)
          ? getMirrorTarget(ctx.app.db, repo.id)
          : undefined;
      return {
        verb: "Stop mirroring",
        title: held
          ? `Stop mirroring ${m[1]}/${m[2]} to ${held.fullName}?`
          : `Stop mirroring ${m[1]}/${m[2]}?`,
        detail: `${held ? held.fullName : "The copy on the other side"} stays as it is; nothing more is pushed to it. Only a new migration sets up a mirror again.`,
        phrase: "",
      };
    },
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/prompts\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Disconnect",
      title: "Disconnect Instagram?",
      detail: `The daily tell from Instagram stops for ${m[1]}/${m[2]}, and the token is forgotten. The issues it already told stay.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/labels\/([^/]+)\/delete$/,
    describe: (m, ctx) => {
      // Only a writer is told the count, so this page reads no private repository's work.
      const repo = getRepo(ctx.app.db, m[1]!, m[2]!);
      const n =
        repo && canWrite(ctx.app.db, repo, ctx.auth.user)
          ? (openLabelCounts(ctx.app.db, repo.id).get(m[3]!) ?? 0)
          : 0;
      const carried = n === 1 ? "item carries" : "items carry";
      const count = n > 0 ? `${n} open ${carried} it. ` : "";
      return {
        verb: "Delete label",
        title: "Delete this label?",
        detail: `${count}It is removed from every issue and pull request in ${m[1]}/${m[2]} that carries it. The issues themselves are untouched.`,
        phrase: "",
      };
    },
  },
  {
    pattern: /^\/boards\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete board",
      title: `Delete the board ${decodeURIComponent(m[1] ?? "")}?`,
      detail: "Its panels and pins go with it. Nothing it reads is touched.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/boards\/([^/]+)\/remove\?index=(\d+)&title=([^&]+)$/,
    describe: (m) => ({
      verb: "Remove panel",
      title: `Remove the panel ${decodedOr(m[3] ?? "")} from ${decodedOr(m[1] ?? "")}?`,
      detail: "Only this panel goes; the board, its other panels and what it reads stay. A pin of it on home goes with it.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/hooks\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete webhook",
      title: "Delete this webhook?",
      detail: `${m[1]}/${m[2]} stops POSTing events to it immediately. Pending deliveries are dropped.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/tokens\/([^/]+)\/delete$/,
    describe: () => ({
      verb: "Revoke token",
      title: "Revoke this access token?",
      detail:
        "Anything using it — a script, a CI job, a git remote — stops working at once. The secret cannot be recovered, only replaced.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/origins\/([^/]+)\/delete$/,
    describe: () => ({
      verb: "Disconnect origin",
      title: "Disconnect this origin?",
      detail: DISCONNECT_DETAIL,
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/cloud\/remove\?provider=([a-z0-9_-]+)&name=([a-z][a-z0-9_]{0,31})$/,
    describe: (m) => ({
      verb: "Remove account",
      title: `Remove the ${m[1]} account ${m[2]}?`,
      detail:
        "Its sealed token is deleted from this forge. Anything that used it stops reaching that provider until you add an account again. Nothing at the provider is touched.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/keys\/([^/]+)\/delete$/,
    describe: () => ({
      verb: "Remove key",
      title: "Remove this SSH key?",
      detail: "The machine holding it can no longer authenticate as you.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/passkeys\/([^/]+)\/delete$/,
    describe: () => ({
      verb: "Remove passkey",
      title: "Remove this passkey?",
      detail: "The device holding it can no longer sign in as you.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/-\/teams\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete team",
      title: "Delete this team?",
      detail: `Its members lose whatever access it granted them in ${m[1]}. The accounts themselves are untouched.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/-\/teams\/([^/]+)\/remove\?user=([A-Za-z0-9_.-]+)$/,
    describe: (m) => ({
      verb: "Remove from team",
      title: `Remove @${m[3]} from this team?`,
      detail: `They lose whatever access this team grants them in ${m[1]}. Their account is untouched.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/app\/disable$/,
    describe: (m) => ({
      verb: STOP_APP,
      title: `Stop running ${m[1]}/${m[2]} as an app?`,
      detail:
        "Production and every preview stop, and their data directories and checkouts are removed from disk. The repository and its code are untouched. Run it as an app again later and it starts from empty data.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/app\/(production|pull-[1-9]\d*)\/stop$/,
    describe: (m) => ({
      verb: "Stop",
      title: `Stop ${m[3]} of ${m[1]}/${m[2]}?`,
      detail:
        "It stops answering at its address until someone presses Redeploy. Its data stays where it is.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/crew\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Retire agent",
      title: `Retire ${decodeURIComponent(m[1] ?? "")}?`,
      detail:
        "Its tokens are destroyed and it leaves every crew it is on, so nothing can act as it again. Pull requests and comments it wrote stay, under its name. This cannot be undone.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/accounts\/([^/]+)\/suspend$/,
    describe: (m) => ({
      verb: "Suspend account",
      title: `Suspend ${decodeURIComponent(m[1] ?? "")}?`,
      detail:
        "Its sessions and tokens stop working at once, it cannot sign in, and its repositories run nothing: queued runs are cancelled and its apps are stopped. Its data stays. You can unsuspend it later.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/accounts\/([^/]+)\/remove$/,
    describe: (m) => {
      const name = decodeURIComponent(m[1] ?? "");
      return {
        verb: "Remove account",
        title: `Remove ${name}?`,
        detail:
          "Its repositories and their apps are deleted, its credentials, keys and connected forges are dropped, and its email is scrubbed. The name stays taken, and what it said on others' threads stays under it. This cannot be undone.",
        phrase: name,
      };
    },
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/take-back$/,
    describe: (m, ctx) => {
      // The number in the URL is what the route itself will act on; the
      // title shown here is looked up fresh rather than trusted from a
      // link, so a crafted URL cannot put someone else's words on it — and
      // only shown to someone who could take the change back anyway, so
      // this page never becomes a way to read a private pull's title.
      const repo = getRepo(ctx.app.db, m[1]!, m[2]!);
      const writer = repo && canWrite(ctx.app.db, repo, ctx.auth.user);
      const pull = writer
        ? getPull(ctx.app.db, repo.id, Number(m[3]))
        : undefined;
      const name = pull ? `"${pull.title}"` : `change #${m[3]}`;
      return {
        verb: "Take it back",
        title: `Take back ${name}?`,
        detail:
          "This opens a new change that undoes exactly what it shipped — nothing changes until a person ships that new change, same as any other.",
        phrase: "",
      };
    },
  },
  {
    pattern: /^\/pinned\/([a-z][a-z0-9-]*)\/(update|rollback|check)$/,
    describe: (m) => {
      const name = m[1]!;
      if (m[2] === "update")
        return {
          verb: "Update",
          title: `Update ${name}?`,
          detail: "The forge is replaced with the version you named. It changes only when you press this, and the change is recorded with your name.",
          phrase: "",
          carries: "version",
        };
      if (m[2] === "rollback")
        return {
          verb: "Roll back",
          title: `Roll ${name} back?`,
          detail: "The forge is replaced with the version the latest change replaced. The change is recorded with your name.",
          phrase: "",
        };
      return {
        verb: "Check",
        title: `Check ${name}?`,
        detail: "The forge reads its droplet's address back and asks the forge there for its front page. Nothing is changed but what it says about itself.",
        phrase: "",
      };
    },
  },
  {
    pattern: /^\/admin\/invites\/([^/]+)\/revoke$/,
    describe: (m) => ({
      verb: "Revoke",
      title: `Revoke invite ${decodeURIComponent(m[1] ?? "")}?`,
      detail:
        "Whoever holds this link can no longer sign up with it. A new link has to be minted to let them in.",
      phrase: "",
    }),
  },
];

/** A path segment decoded, or as it came when it is not valid percent-encoding. */
function decodedOr(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function describeTarget(to: string, ctx: Ctx): Destructive | undefined {
  for (const entry of DESTRUCTIVE) {
    const match = to.match(entry.pattern);
    if (match) return entry.describe(match, ctx);
  }
  return undefined;
}

/**
 * The confirmation step for anything destructive. Every dangerous button is a
 * link to this page, so the mutation needs a second, deliberate POST — with
 * or without JavaScript, and with no way to arrive here by a stray click.
 *
 * `to` is the POST target and is checked twice: it must be a path on this
 * forge (never absolute or protocol-relative), and it must be a route the
 * table above recognises as destructive.
 */
export function confirmPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "render", () => confirmBody(ctx));
}

function confirmBody(ctx: Ctx): Response {
  const params = ctx.url.searchParams;
  const to = params.get("to") ?? "";
  if (
    !to.startsWith("/") ||
    to.startsWith("//") ||
    to.includes("\\") ||
    /[\n\r]/.test(to)
  ) {
    return notFoundPage(ctx);
  }
  const known = describeTarget(to, ctx);
  // Only routes this file knows are destructive can be confirmed. A crafted
  // link therefore cannot invent reassuring words for a dangerous button, and
  // cannot aim the form at an endpoint that was never meant for it.
  if (!known) return notFoundPage(ctx);
  const { verb, title, detail, phrase, carries } = known;
  const carried = carries === undefined ? "" : (params.get(carries) ?? "").slice(0, 200);

  const referer = ctx.request.headers.get("referer");
  let back = "/";
  if (referer !== null) {
    const parsed = URL.parse(referer);
    if (parsed && parsed.origin === ctx.url.origin)
      back = parsed.pathname + parsed.search;
  }

  const body = html`<div class="narrow-wide">
    ${pageHead(title)}
    <p>${detail}</p>
    <form method="post" action="${to}" class="mt">
      ${carries === undefined ? null : html`<input type="hidden" name="${carries}" value="${carried}" />`}
      ${when(phrase !== "", () =>
        formField({
          label: `Type ${phrase} to continue`,
          name: "confirm",
          required: true,
          autofocus: true,
          mono: true,
          autocomplete: "off",
        }),
      )}
      <div class="form-actions">
        ${btn(verb, { variant: "danger" })}
        ${btn("Cancel", { href: back, variant: "ghost" })}
      </div>
    </form>
  </div>`;
  return page({ ctx, title: `${verb} · forge`, body });
}
