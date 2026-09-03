/**
 * Finding things, and confirming the things you cannot take back.
 *
 * `/search` is the no-JavaScript twin of the command palette: one query box
 * over the repositories and issues the viewer may see. `/-/confirm` is the
 * second, deliberate step every destructive POST passes through — and the
 * only page in the product that knows which routes are dangerous, so a
 * crafted link can neither invent reassuring words nor aim at an endpoint
 * that was never meant to be confirmed.
 */

import { search } from "../../actions/search.ts";
import {
  searchKind,
  type CodeHit,
  type IssueHit,
  type RepoHit,
  type SearchKind,
  type SearchResults,
} from "../../core/search.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { page } from "../layout.ts";
import { browseBase } from "../scope.ts";
import {
  badge,
  btn,
  card,
  empty,
  field as formField,
  listCard,
  repoCounts,
  row,
  seg,
  stateBadge,
  time,
} from "../ui.ts";

// ---- search ----

/**
 * One repository hit, ours or an origin's. The where-dot is the same glyph
 * the repository pages use, so "this is somewhere else" reads the same in a
 * result list as it does on the page you land on.
 */
function repoHitRow(hit: RepoHit): Html {
  const counts = repoCounts({
    openIssues: hit.openIssues,
    openPulls: hit.openPulls,
    ...(hit.source === "origin"
      ? { issuesIncludePulls: hit.openIssuesIncludingPulls }
      : {}),
  });
  if (hit.source === "local") {
    return row({
      href: `/${hit.owner}/${hit.name}`,
      nav: true,
      lead: icon("repo"),
      title: `${hit.owner}/${hit.name}`,
      titleAttr: `${hit.owner}/${hit.name}`,
      meta: html`<span class="where-place" data-state="reading"
          ><span class="where-dot" aria-hidden="true">●</span>workbench</span
        >${hit.description === "" ? null : html` · ${hit.description}`}`,
      trail: html`${counts}${when(hit.visibility === "private", () =>
        badge("Private", { icon: "lock", variant: "secondary" }),
      )}`,
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
        ><span class="where-dot" aria-hidden="true"
          >${mirror === null ? "○" : "●"}</span
        >${mirror === null
          ? "not mirrored here"
          : `mirrored as ${mirror.owner}/${mirror.name}`}</span
      >${hit.description === "" ? null : html` · ${hit.description}`}`,
    trail: html`${counts}${when(hit.private, () =>
      badge("Private", { icon: "lock", variant: "secondary" }),
    )}`,
  });
}

/** One conversation hit. An origin's own goes out to the origin. */
function issueHitRow(hit: IssueHit): Html {
  const segment = hit.kind === "issue" ? "issues" : "pulls";
  const where =
    hit.source === "local"
      ? `${hit.repo.owner}/${hit.repo.name}`
      : hit.fullName;
  return row({
    href:
      hit.source === "local"
        ? `/${hit.repo.owner}/${hit.repo.name}/${segment}/${hit.number}`
        : hit.htmlUrl,
    nav: true,
    lead: icon(hit.kind === "issue" ? "issue" : "pull"),
    title: hit.title,
    titleAttr: hit.title,
    meta: html`${where} #${hit.number} · updated ${time(hit.updatedAt)}${hit.source ===
    "origin"
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
    <a class="row code-hit" data-nav tabindex="-1" href="${at}/blob/HEAD/${hit.path}#L${hit.line}">
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
    </a>
  </li>`;
}

const KINDS: { value: SearchKind; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "repos", label: "Repositories" },
  { value: "issues", label: "Issues & pulls" },
  { value: "code", label: "Code" },
];

function searchHref(
  query: string,
  kind: SearchKind,
  live: boolean,
): string {
  const params = new URLSearchParams({ q: query });
  if (kind !== "all") params.set("kind", kind);
  if (live) params.set("live", "1");
  return `/search?${params.toString()}`;
}

function section(
  title: string,
  kind: SearchKind,
  rows: Html[],
  o: { truncated: boolean; emptyIcon: Parameters<typeof icon>[0]; emptyText: string; query: string; live: boolean },
): Html {
  return html`<h2 class="mt" id="${kind}">
      ${title}${rows.length === 0
        ? null
        : html` <span class="muted small num"
            >${rows.length}${o.truncated ? "+" : ""}</span
          >`}
    </h2>
    ${rows.length === 0
      ? html`<p class="no-hits muted small">
          ${icon(o.emptyIcon)}<span>${o.emptyText}</span>
        </p>`
      : listCard(rows)}
    ${when(
      o.truncated,
      () =>
        html`<p class="muted small mt">
          More matched than fit here.
          <a href="${searchHref(o.query, kind, o.live)}">Show only ${title.toLowerCase()}</a>.
        </p>`,
    )}`;
}

/**
 * GET /search — the whole forge, in one box.
 *
 * It is the no-JavaScript twin of the palette and the only search that is
 * always right: the same `search()` action the API and the palette call, so
 * the four sources (repositories here, repositories cached from every origin,
 * conversations, and the code itself) can never disagree between surfaces.
 *
 * `live=1` is opt-in and stays opt-in: it spends a round trip on every
 * connected origin, which is not a thing to do on every keystroke.
 */
export async function searchPage(ctx: Ctx): Promise<Response> {
  const params = ctx.url.searchParams;
  const query = (params.get("q") ?? "").trim();
  const kind = searchKind(params.get("kind"));
  const live = params.get("live") === "1";
  const hasOrigins = ctx.auth.user !== undefined;

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
      placeholder="Search repositories, issues and code"
      aria-label="Search"
      autofocus
      data-search-input
    />
    ${when(kind !== "all", () =>
      html`<input type="hidden" name="kind" value="${kind}" />`,
    )}
    ${when(live, () => html`<input type="hidden" name="live" value="1" />`)}
    <button class="btn" data-variant="primary" data-size="sm" type="submit">
      Search
    </button>
  </form>`;

  if (query === "") {
    return page({
      ctx,
      title: "Search",
      body: html`${pageHead("Search")} ${form}
      ${empty({
        icon: "search",
        title: "Search this forge",
        note: "Repository names, issue and pull-request titles, and the code itself — across everything you can see, here and on every origin you have connected.",
      })}`,
    });
  }

  const found: SearchResults = await search(ctx.app, ctx.auth.user, {
    q: query,
    kind,
    live,
  });

  const chips = seg(
    KINDS.map((k) => ({
      label: k.label,
      href: searchHref(query, k.value, live),
      current: k.value === kind,
    })),
  );

  const liveToggle = when(
    hasOrigins,
    () =>
      html`<p class="live-toggle small">
        ${icon("globe")}
        ${live
          ? html`<span
              >Asking every connected origin's own search, live.
              <a href="${searchHref(query, kind, false)}">Use the cache</a
              >.</span
            >`
          : html`<span
              >Origins are searched from the cache.
              <a href="${searchHref(query, kind, true)}"
                >Search live on origins</a
              >
              — a round trip to each connected origin, so it costs a
              moment.</span
            >`}
      </p>`,
  );

  const wants = (which: SearchKind) => kind === "all" || kind === which;

  const body = html`${pageHead(html`Results for “${query}”`)} ${form} ${chips}
    ${liveToggle}
    ${when(wants("repos"), () =>
      section(
        "Repositories",
        "repos",
        found.repos.map(repoHitRow),
        {
          truncated: found.truncated.repos,
          emptyIcon: "repo",
          emptyText: "No repository matches",
          query,
          live,
        },
      ),
    )}
    ${when(wants("issues"), () =>
      section(
        "Issues and pull requests",
        "issues",
        found.issues.map(issueHitRow),
        {
          truncated: found.truncated.issues,
          emptyIcon: "issue",
          emptyText: "No issue or pull request matches",
          query,
          live,
        },
      ),
    )}
    ${when(wants("code"), () =>
      section(
        "Code",
        "code",
        found.code.map((hit) => codeHitRow(hit, query)),
        {
          truncated: found.truncated.code,
          emptyIcon: "code",
          emptyText: "No line of code matches",
          query,
          live,
        },
      ),
    )}`;
  return page({ ctx, title: `Search · ${query}`, body });
}

// ---- confirmation ----

interface Destructive {
  verb: string;
  title: string;
  detail: string;
  /** A phrase the visitor must type back before the button will work. */
  phrase: string;
}

/**
 * The routes this page will confirm, and the words it uses for each. The
 * wording is derived here, never taken from the link — otherwise a mailed
 * URL could put "Continue" on a button that deletes a repository.
 */
const DESTRUCTIVE: {
  pattern: RegExp;
  describe: (m: RegExpMatchArray) => Destructive;
}[] = [
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/delete$/,
    describe: (m) => ({
      verb: "Delete this repository",
      title: `Delete ${m[1]}/${m[2]}?`,
      detail:
        "Every issue, pull request, comment and webhook goes with it, and the git objects are removed from disk. Forks are detached first and keep working. This cannot be undone.",
      phrase: `${m[1]}/${m[2]}`,
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
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/labels\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete label",
      title: "Delete this label?",
      detail: `It is removed from every issue and pull request in ${m[1]}/${m[2]} that carries it. The issues themselves are untouched.`,
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
      detail:
        "The stored credential is destroyed here immediately, and the repositories mirroring it stop syncing — they keep their git objects, issues and comments, and go on being readable as ordinary local repositories. The grant is revoked upstream only where the forge allows it (GitHub, and only when this forge has a client secret configured); everywhere else revoke the token on the origin yourself. The message after this says which happened.",
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
    pattern: /^\/([^/]+)\/-\/teams\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete team",
      title: "Delete this team?",
      detail: `Its members lose whatever access it granted them in ${m[1]}. The accounts themselves are untouched.`,
      phrase: "",
    }),
  },
];

function describeTarget(to: string): Destructive | undefined {
  for (const entry of DESTRUCTIVE) {
    const match = to.match(entry.pattern);
    if (match) return entry.describe(match);
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
  const known = describeTarget(to);
  // Only routes this file knows are destructive can be confirmed. A crafted
  // link therefore cannot invent reassuring words for a dangerous button, and
  // cannot aim the form at an endpoint that was never meant for it.
  if (!known) return notFoundPage(ctx);
  const { verb, title, detail, phrase } = known;

  const referer = ctx.request.headers.get("referer");
  let back = "/";
  if (referer !== null) {
    const parsed = URL.parse(referer);
    if (parsed && parsed.origin === ctx.url.origin)
      back = parsed.pathname + parsed.search;
  }

  const body = html`<div class="narrow-wide">
    ${pageHead(title)}
    ${card(
      html`<p>${detail}</p>
        <form method="post" action="${to}" class="mt">
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
        </form>`,
      {
        tone: "danger",
        head: html`${icon("alert")}
          <h2>${verb}</h2>`,
      },
    )}
  </div>`;
  return page({ ctx, title: `${verb} · forge`, body });
}
