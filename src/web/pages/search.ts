/**
 * Finding things, and confirming the things you cannot take back.
 *
 * `/search` is the one search, in either face, and it needs no script: one
 * query box over every repository and conversation the viewer may see. The
 * studio face says it in the studio's nouns — apps, tells, changes — and
 * leaves the code to dev's face, one link away. `/-/confirm` is the
 * second, deliberate step every destructive POST passes through — and the
 * only page in the product that knows which routes are dangerous, so a
 * crafted link can neither invent reassuring words nor aim at an endpoint
 * that was never meant to be confirmed.
 */

import { search } from "../../actions/search.ts";
import { appsRuntime, envsFor } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import { getPull } from "../../core/pulls.ts";
import { canEnterApp, canWrite, getRepo, getRepoById } from "../../core/repos.ts";
import {
  cleanQuery,
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
import { appsOf } from "../studio/asks.ts";
import { changeHref, tellHref } from "../studio/nouns.ts";
import {
  badge,
  btn,
  card,
  dot,
  empty,
  field as formField,
  listCard,
  repoCounts,
  row,
  seg,
  stateBadge,
  time,
  type Tone,
} from "../ui.ts";

// ---- search ----

/** What was asked, and in which face — everything a link back needs. */
interface Asked {
  readonly query: string;
  readonly kind: SearchKind;
  readonly live: boolean;
  /** The studio's face: its nouns, and no code. */
  readonly studio: boolean;
  /** `?mode=dev` from a studio browser, kept on every link and the form. */
  readonly escape: boolean;
}

/** The apps among what the viewer can see, by id and by `owner/name`. One
 * read for the whole page, never one per row. */
interface Apps {
  readonly byId: ReadonlyMap<string, AppRecord>;
  readonly names: ReadonlySet<string>;
}

const NO_APPS: Apps = { byId: new Map(), names: new Set() };

const privateBadge = (yes: boolean): Html =>
  when(yes, () => badge("Private", { icon: "lock", variant: "secondary" }));

/** Whether an app is live. No query — `runtime.status` reads what is
 * already in memory. Undefined for a private app the viewer may not enter:
 * its state is its writers' and crew's (`envsFor`), and "not running" would
 * be a guess dressed as a fact. */
function appState(
  ctx: Ctx,
  record: AppRecord,
): { tone: Tone; word: string } | undefined {
  if (record.access === "private") {
    const repo = getRepoById(ctx.app.db, record.repoId);
    if (
      repo === undefined ||
      !canEnterApp(ctx.app.db, repo, record, ctx.auth.user, { named: false })
    )
      return undefined;
  }
  const envs = envsFor(ctx.app, ctx.auth.user, record);
  const state = envs.find((e) => e.env === "production")?.state ?? "stopped";
  const tone: Tone =
    state === "running" ? "success" : state === "failed" ? "danger" : "default";
  const word =
    state === "running" ? "live" : state === "stopped" ? "not running" : state;
  return { tone, word };
}

/**
 * One repository hit, ours or an origin's. In dev the where-dot is the same
 * glyph the repository pages use, so "this is somewhere else" reads the same
 * in a result list as it does on the page you land on; in the studio an app
 * says whether it is live instead.
 */
function repoHitRow(ctx: Ctx, a: Asked, apps: Apps, hit: RepoHit): Html {
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
    const live = record === undefined ? undefined : appState(ctx, record);
    return row({
      href: `/${name}`,
      nav: true,
      lead: live === undefined ? icon("repo") : dot(live.tone),
      title: name,
      titleAttr: hit.description || name,
      meta: a.studio
        ? hit.description === ""
          ? html`<span class="muted">No description</span>`
          : html`${hit.description}`
        : html`<span class="where-place" data-state="reading"
              ><span class="where-dot" aria-hidden="true">●</span
              >workbench</span
            >${description}`,
      trail: html`${a.studio
        ? when(live, (l) => badge(l.word, { tone: l.tone }))
        : counts}${privateBadge(hit.visibility === "private")}`,
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
      >${description}`,
    trail: html`${counts}${privateBadge(hit.private)}`,
  });
}

/** Where a conversation here lives: the studio's noun on an app, so a
 * person is never handed two addresses for one thing; dev's otherwise. */
function localIssueHref(
  a: Asked,
  apps: Apps,
  hit: IssueHit & { source: "local" },
): string {
  const base = `/${hit.repo.owner}/${hit.repo.name}`;
  if (a.studio && apps.names.has(`${hit.repo.owner}/${hit.repo.name}`))
    return hit.kind === "issue"
      ? tellHref(base, hit.number)
      : changeHref(base, hit.number);
  return `${base}/${hit.kind === "issue" ? "issues" : "pulls"}/${hit.number}`;
}

/** One conversation hit. An origin's own goes out to the origin. */
function issueHitRow(a: Asked, apps: Apps, hit: IssueHit): Html {
  const where =
    hit.source === "local"
      ? `${hit.repo.owner}/${hit.repo.name}`
      : hit.fullName;
  return row({
    href:
      hit.source === "local" ? localIssueHref(a, apps, hit) : hit.htmlUrl,
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
    </a>
  </li>`;
}

/** Each kind in each face's words: [kind, chip, heading, nothing found].
 * The studio has no code row — that search is dev's. */
type Words = readonly [SearchKind, string, string, string];
const WORDS: { studio: readonly Words[]; dev: readonly Words[] } = {
  studio: [
    ["all", "Everything", "", ""],
    ["repos", "Apps", "Apps", "No app matches"],
    [
      "issues",
      "Tells & changes",
      "Tells and changes",
      "No tell or change matches",
    ],
  ],
  dev: [
    ["all", "Everything", "", ""],
    ["repos", "Repositories", "Repositories", "No repository matches"],
    [
      "issues",
      "Issues & pulls",
      "Issues and pull requests",
      "No issue or pull request matches",
    ],
    ["code", "Code", "Code", "No line of code matches"],
  ],
};

function searchHref(
  a: Asked,
  over: { kind?: SearchKind; live?: boolean; escape?: boolean } = {},
): string {
  const kind = over.kind ?? a.kind;
  const params = new URLSearchParams({ q: a.query });
  if (kind !== "all") params.set("kind", kind);
  if (over.live ?? a.live) params.set("live", "1");
  if (over.escape ?? a.escape) params.set("mode", "dev");
  return `/search?${params.toString()}`;
}

function section(
  a: Asked,
  [kind, , title, emptyText]: Words,
  rows: Html[],
  truncated: boolean,
): Html {
  const emptyIcon =
    kind === "repos" ? "repo" : kind === "issues" ? "issue" : "code";
  return html`<h2 class="mt" id="${kind}">
      ${title}${rows.length === 0
        ? null
        : html` <span class="muted small num"
            >${rows.length}${truncated ? "+" : ""}</span
          >`}
    </h2>
    ${rows.length === 0
      ? html`<p class="no-hits muted small">
          ${icon(emptyIcon)}<span>${emptyText}</span>
        </p>`
      : listCard(rows)}
    ${when(
      truncated,
      () =>
        html`<p class="muted small mt">
          More matched than fit here.
          <a href="${searchHref(a, { kind })}"
            >Show only ${title.toLowerCase()}</a
          >.
        </p>`,
    )}`;
}

/** The same `search()` the API and the palette call, so the sources can
 * never disagree between surfaces. The studio leaves the code to dev, so
 * its "everything" is the two cheap asks, never a grep. */
async function find(ctx: Ctx, a: Asked): Promise<SearchResults> {
  const ask = (kind: SearchKind) =>
    search(ctx.app, ctx.auth.user, { q: a.query, kind, live: a.live });
  if (!a.studio || a.kind !== "all") return ask(a.kind);
  const [repos, issues] = await Promise.all([ask("repos"), ask("issues")]);
  return {
    repos: repos.repos,
    issues: issues.issues,
    code: [],
    truncated: { ...issues.truncated, repos: repos.truncated.repos },
  };
}

/**
 * GET /search — everything the viewer can see, in one box, with no script.
 *
 * The face follows the mode, like every other page: the studio's nouns in
 * the studio, dev's (and dev's code search) in dev, and `?mode=dev` is the
 * one-off way to dev's face without switching the browser. Either way it
 * is the same visibility, so a signed-out reader sees exactly the public
 * repositories a signed-out reader would anywhere else.
 *
 * `live=1` is opt-in and stays opt-in: it spends a round trip on every
 * connected origin, which is not a thing to do on every keystroke.
 */
export async function searchPage(ctx: Ctx): Promise<Response> {
  const params = ctx.url.searchParams;
  const escape = params.get("mode") === "dev";
  const studio = ctx.mode === "studio" && !escape;
  const asked = searchKind(params.get("kind"));
  const a: Asked = {
    query: cleanQuery(params.get("q") ?? ""),
    kind: studio && asked === "code" ? "all" : asked,
    live: params.get("live") === "1",
    studio,
    escape,
  };
  const words = studio ? WORDS.studio : WORDS.dev;

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
      value="${a.query}"
      placeholder="${studio
        ? "Search your apps, changes and tells"
        : "Search repositories, issues and code"}"
      aria-label="Search"
      autofocus
      data-search-input
    />
    ${when(
      a.kind !== "all",
      () => html`<input type="hidden" name="kind" value="${a.kind}" />`,
    )}
    ${when(a.live, () => html`<input type="hidden" name="live" value="1" />`)}
    ${when(
      escape,
      () => html`<input type="hidden" name="mode" value="dev" />`,
    )}
    <button class="btn" data-variant="primary" data-size="sm" type="submit">
      Search
    </button>
  </form>`;

  if (a.query === "") {
    return page({
      ctx,
      title: "Search",
      body: html`${pageHead("Search")} ${form}
      ${empty({
        icon: "search",
        title: studio ? "Search your studio" : "Search this forge",
        note: studio
          ? "An app's name or description, or a word from what was told or changed."
          : "Repository names, issue and pull-request titles, and the code itself — across everything you can see, here and on every origin you have connected.",
      })}`,
    });
  }

  const found = await find(ctx, a);
  let apps = NO_APPS;
  if (studio) {
    const seen = appsOf(ctx, ctx.auth.user);
    apps = {
      byId: seen.records,
      names: new Set(seen.repos.map((r) => `${r.ownerName}/${r.name}`)),
    };
  }

  const chips = seg(
    words.map(([kind, label]) => ({
      label,
      href: searchHref(a, { kind }),
      current: kind === a.kind,
    })),
  );

  const liveToggle = when(
    ctx.auth.user !== undefined,
    () =>
      html`<p class="live-toggle small">
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
      found.repos.map((hit) => repoHitRow(ctx, a, apps, hit)),
      found.truncated.repos,
    ],
    issues: () => [
      found.issues.map((hit) => issueHitRow(a, apps, hit)),
      found.truncated.issues,
    ],
    code: () => [
      found.code.map((hit) => codeHitRow(hit, a.query)),
      found.truncated.code,
    ],
  };

  const body = html`${pageHead(html`Results for “${a.query}”`)} ${form}
  ${chips} ${liveToggle}
  ${words
    .filter(
      ([kind]) => kind !== "all" && (a.kind === "all" || a.kind === kind),
    )
    .map((w) => section(a, w, ...rows[w[0]]()))}
  ${when(
    studio,
    () =>
      html`<p class="muted small mt">
        ${icon("code")} Looking for a line of code?
        <a href="${searchHref(a, { kind: "code", escape: true })}"
          >Search the code</a
        >.
      </p>`,
  )}`;
  return page({ ctx, title: `Search · ${a.query}`, body });
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
  describe: (m: RegExpMatchArray, ctx: Ctx) => Destructive;
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
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/app\/domains\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Remove domain",
      title: `Remove ${decodeURIComponent(m[3] ?? "")}?`,
      detail: `The forge stops answering there at once; links to it stop working until the name is added and verified again. ${m[1]}/${m[2]} keeps its own hostname.`,
      phrase: "",
    }),
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
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/app\/disable$/,
    describe: (m) => ({
      verb: "Stop running as an app",
      title: `Stop running ${m[1]}/${m[2]} as an app?`,
      detail:
        "Production and every preview stop, and their data directories and checkouts are removed from disk. The repository and its code are untouched. Run it as an app again later and it starts from empty data.",
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
];

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
