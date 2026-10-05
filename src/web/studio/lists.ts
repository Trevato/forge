/**
 * The forge's three lists — everything told, every change, every run — and
 * the one filter bar they share: five words, each a link carrying `?word=`,
 * so what a person is looking at lives in the address and can be shared. A
 * row is the same word, note and time the thing's own page shows, because
 * every one of them is read through `tellWord`/`pullWord`/`runWord`. Each
 * list is bounded to one page. Told and changes are the only lists of
 * issues and pulls there are: every repository, every viewer, at `/issues`
 * and `/tells`, `/pulls` and `/changes` alike.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import {
  labelsForIssues,
  listIssues,
  listLabels,
  type Issue,
  type Label,
} from "../../core/issues.ts";
import { listPulls, openPullsClosing } from "../../core/pulls.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { waitingCount } from "../../actions/reports.ts";
import { listRuns } from "../../core/runs.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
} from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  btn,
  empty,
  icon,
  labelChip,
  labelCss,
  listCard,
  originTag,
  pager,
  row,
  seg,
  time,
} from "../ui.ts";
import { actorsFor, issuesFor, runTitleFrom } from "../pages/runs.ts";
import { originGlyph } from "../pages/thread.ts";
import { changeHref, PAGE_TITLES, pageTitle, tellHref } from "./nouns.ts";
import { tellLine, tellsAnswered } from "./branch_tell.ts";
import { tellWord } from "./tell.ts";
import {
  pullWord,
  runWord,
  wordBadge,
  type Word,
  servingHistory,
  type WordCtx,
} from "./words.ts";

/** The five words a studio list filters by. `waiting` and `planned` are
 * still moving, so they fold into `working`; `done` is a deploy or a check
 * that finished with nothing else to show, so it folds into `shipped`;
 * `cancelled` is still a run that did not land, so it folds into `stopped`
 * — the one place the nine-word vocabulary above buckets down to the five a
 * list links to. */
type WordFilter = "told" | "working" | "look" | "shipped" | "stopped";

const WORD_FILTERS: readonly WordFilter[] = [
  "told",
  "working",
  "look",
  "shipped",
  "stopped",
];

function listBucket(word: Word): WordFilter {
  if (word === "waiting" || word === "planned") return "working";
  if (word === "done") return "shipped";
  if (word === "cancelled") return "stopped";
  return word;
}

/** The word named in `?word=`, when it is one of the five. */
function readWordFilter(ctx: Ctx): WordFilter | undefined {
  const raw = ctx.url.searchParams.get("word") ?? "";
  return (WORD_FILTERS as readonly string[]).includes(raw)
    ? (raw as WordFilter)
    : undefined;
}

/** Whether a row belongs on the page shown: the exact word the URL asked
 * for, else "open and moving" — told, working or look, never shipped or
 * stopped. */
function inWordFilter(word: Word, filter: WordFilter | undefined): boolean {
  const bucket = listBucket(word);
  return filter === undefined
    ? bucket === "told" || bucket === "working" || bucket === "look"
    : bucket === filter;
}

/** The empty card's one line. A filter that is set is named, so the way out
 * is visible; none set is not the filter's fault, so it says what to do. */
function emptyNote(
  filter: WordFilter | undefined,
  subject: string,
  starter: string,
): string {
  if (filter === undefined) return starter;
  return `${subject} is ${filter} yet.`;
}

/** A filter bar of five words, each a link carrying `?word=` — never a
 * form, so the filter lives in the address and can be shared. No filter
 * reads as "Open": what is open and moving. `trail` sits at the bar's far
 * end — the one verb a list offers besides opening a row. */
function wordFilterBar(
  href: (word: WordFilter | undefined) => string,
  current: WordFilter | undefined,
  open: boolean,
  trail?: Html,
): Html {
  return html`<div class="filters mb">
    ${seg([
      { label: "Open", href: href(undefined), current: open },
      ...WORD_FILTERS.map((w) => ({
        label: w[0]!.toUpperCase() + w.slice(1),
        href: href(w),
        current: current === w,
      })),
    ])}
    ${when(trail, (t) => html`<span class="spacer"></span>${t}`)}
  </div>`;
}

const LIST_PAGE = 25;

/** `?word=` carried onto a `cursor` link, so paging keeps the filter. */
function pagedHref(base: string, filter: WordFilter | undefined, cursor: string): string {
  return `${base}?${filter ? `word=${filter}&` : ""}cursor=${cursor}`;
}

/**
 * What a list of tells or changes is narrowed by, read once from the
 * address: the word, and the narrowings that are not words — a label, who
 * has it, who opened it, a piece of the title. `state` is the older
 * address's `?state=closed|all`, still answered so a link written to it
 * keeps meaning what it said.
 */
interface ListFacets {
  word: WordFilter | undefined;
  state: "open" | "closed" | "all";
  label: string;
  assignee: string;
  author: string;
  q: string;
}

type FacetName = "label" | "assignee" | "author" | "q";

function readFacets(ctx: Ctx): ListFacets {
  const params = ctx.url.searchParams;
  const state = params.get("state");
  return {
    word: readWordFilter(ctx),
    state: state === "closed" || state === "all" ? state : "open",
    label: params.get("label") ?? "",
    assignee: params.get("assignee") ?? "",
    author: params.get("author") ?? "",
    q: params.get("q") ?? "",
  };
}

/** The list's own address with one thing changed — narrowings compose
 * instead of replacing each other, and a word always starts from open. */
function facetHref(
  base: string,
  f: ListFacets,
  patch: Partial<Pick<ListFacets, FacetName>> & {
    word?: WordFilter | undefined;
  },
  cursor?: number,
): string {
  const params = new URLSearchParams();
  const word = "word" in patch ? patch.word : f.word;
  if (word !== undefined) params.set("word", word);
  else if (!("word" in patch) && f.state !== "open")
    params.set("state", f.state);
  for (const name of ["label", "assignee", "author", "q"] as const) {
    const value = patch[name] ?? f[name];
    if (value !== "") params.set(name, value);
  }
  if (cursor !== undefined) params.set("cursor", String(cursor));
  const text = params.toString();
  return text === "" ? base : `${base}?${text}`;
}

/** The issue state to fetch for these facets: a word that has finished
 * reads closed rows, any other word open ones, and no word what `state`
 * says. */
function fetchState(f: ListFacets): "open" | "closed" | "all" {
  if (f.word === "shipped" || f.word === "stopped") return "closed";
  return f.word === undefined ? f.state : "open";
}

/** Whether a row's word belongs on the page: the word asked for, else open
 * and moving — or, on an older `?state=` address, everything it fetched. */
function shown(word: Word, f: ListFacets): boolean {
  return f.word === undefined && f.state !== "open"
    ? true
    : inWordFilter(word, f.word);
}

/** The narrowings in force as chips, each ✕ clearing itself, then the
 * repository's labels to narrow by. Nothing at all when there is neither. */
function facetChips(base: string, f: ListFacets, labels: readonly Label[]): Html {
  const active = (
    [
      ["assignee", "has it"],
      ["author", "opened it"],
      ["q", "in the title"],
    ] as const
  ).filter(([name]) => f[name] !== "");
  if (active.length === 0 && labels.length === 0) return html``;
  return html`<div class="bar mb">
    ${active.map(
      ([name, says]) =>
        html`<a
          class="label"
          href="${facetHref(base, f, { [name]: "" })}"
          aria-current="true"
          title="Remove this filter"
          >${f[name]} ${says} ✕</a
        >`,
    )}
    ${labels.map((l) =>
      f.label.toLowerCase() === l.name.toLowerCase()
        ? html`<a
            class="label lc-${l.color}"
            href="${facetHref(base, f, { label: "" })}"
            aria-current="true"
            title="Remove this filter"
            >${l.name} ✕</a
          >`
        : labelChip(l, facetHref(base, f, { label: l.name })),
    )}
  </div>`;
}

/** The word for a tell closed with nothing merged to shut it — `tellWord`
 * has none, and a list must not drop the row: closed as done is *done*, and
 * dropped or split is *cancelled*, so it is found under shipped or stopped
 * exactly where the person who closed it would look. */
function closedWord(issue: Issue): { word: Word; note: string } {
  return issue.closeReason === "dropped"
    ? { word: "cancelled", note: "dropped" }
    : issue.closeReason === "split"
      ? { word: "cancelled", note: "split into others" }
      : { word: "done", note: "closed as done" };
}

/** A row's title with its label chips after it. */
function titled(title: string, labels: readonly Label[] | undefined): Html {
  return html`${title}${(labels ?? []).map((l) => html` ${labelChip(l)}`)}`;
}

/** What every list read here shares: the facets as `listIssues` options,
 * the word context and the cursor. The app record is the repository's own,
 * not the viewer's mode — the words a row wears are the same for everyone. */
function listRead(ctx: Ctx, repo: Repo, f: ListFacets) {
  const rawCursor = Number(ctx.url.searchParams.get("cursor"));
  const cursor =
    Number.isSafeInteger(rawCursor) && rawCursor > 0 ? rawCursor : undefined;
  const options = {
    state: fetchState(f),
    limit: LIST_PAGE,
    ...(f.label !== "" ? { label: f.label } : {}),
    ...(f.assignee !== "" ? { assignee: f.assignee } : {}),
    ...(f.author !== "" ? { author: f.author } : {}),
    ...(f.q.trim() !== "" ? { query: f.q } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
  const record = getAppByRepo(ctx.app.db, repo.id);
  const wordCtx: WordCtx = {
    db: ctx.app.db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
    history: servingHistory(),
  };
  return { options, record, wordCtx };
}

/**
 * GET /:owner/:name/issues, and /tells: everything told, for every
 * repository and every viewer — one row per issue in its studio word, who
 * has it, its labels, when it last moved, and the tell itself as the row's
 * own link. `?word=` narrows it, and so do `?label=`, `?assignee=`,
 * `?author=` and `?q=`. Bounded to one page: `tellWord` costs a few small
 * reads per row.
 */
export async function tellsList(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const db = ctx.app.db;
  const base = repoBase(repo);
  const f = readFacets(ctx);
  const { options, record, wordCtx } = listRead(ctx, repo, f);

  const fetched = listIssues(db, repo.id, { ...options, kind: "issue" }).filter(
    (issue) => issue.id !== repo.directionIssueId,
  );
  const closingPulls = openPullsClosing(db, repo.id);
  const words = await Promise.all(
    fetched.map(
      async (issue) =>
        (await tellWord(wordCtx, repo, issue, closingPulls.get(issue.number))) ??
        closedWord(issue),
    ),
  );
  const labels = labelsForIssues(db, fetched.map((issue) => issue.id));
  const repoLabels = listLabels(db, repo.id);
  const rows = fetched
    .map((issue, i) => ({ issue, info: words[i]! }))
    .filter((r) => shown(r.info.word, f));

  const list =
    rows.length === 0
      ? empty({
          icon: "issue",
          title: "Nothing here",
          note: emptyNote(f.word, "Nothing told", "Nothing open. Tell the crew what you want and it shows up here."),
        })
      : listCard(
          rows.map(({ issue, info }) =>
            row({
              href: tellHref(base, issue.number),
              nav: true,
              lead: avatar(issue.assigneeName ?? "crew"),
              title: titled(issue.title, labels.get(issue.id)),
              titleAttr: issue.title,
              meta: html`${when(
                issue.originAuthor,
                (login) => html`${originTag(login, originGlyph(repo))} · `,
              )}${issue.assigneeName
                ? html`${issue.assigneeName} · `
                : null}${info.note} · ${time(issue.updatedAt)}`,
              trail: wordBadge(info.word),
            }),
          ),
        );
  const lastNumber = fetched[fetched.length - 1]?.number;
  // Self-links follow whichever noun reached this page — `/tells` or
  // `/issues` — so paging never jumps a reader to the other address.
  const listBase = ctx.url.pathname;
  // The one verb besides opening a row: say what you want. It posts from
  // `/issues/new`, the compose page, in the words the repository has.
  const compose = when(ctx.auth.user, () =>
    btn(PAGE_TITLES.compose[record === undefined ? "dev" : "studio"], {
      href: `${base}/issues/new`,
      size: "sm",
      variant: "outline",
      icon: "plus",
      shortcut: "c",
    }),
  );
  // A stranger can still say something is wrong on a public repository;
  // its writers see how many such reports wait for them.
  const outside =
    ctx.auth.user === undefined && canRead(db, repo, undefined)
      ? btn("Report a problem", {
          href: `${base}/report`,
          size: "sm",
          variant: "ghost",
        })
      : undefined;
  const waiting = waitingCount(ctx.app, ctx.auth.user, repo);
  const reports =
    waiting > 0
      ? btn(`${waiting} from outside`, { href: `${base}/reports`, size: "sm" })
      : undefined;
  const verbs =
    ctx.auth.user === undefined && outside === undefined
      ? undefined
      : html`${reports ?? null} ${compose} ${outside ?? null}`;

  const body = html`${repoHeader(ctx, repo, "issues")}
    <div class="mt">
      ${wordFilterBar(
        (word) => facetHref(listBase, f, { word }),
        f.word,
        f.word === undefined && f.state === "open",
        verbs,
      )}
      ${facetChips(listBase, f, repoLabels)} ${list}
      ${pager(
        fetched.length === LIST_PAGE && lastNumber !== undefined
          ? { next: facetHref(listBase, f, {}, lastNumber) }
          : {},
      )}
    </div>
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: pageTitle("tells", repo, true),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: labelCss([...repoLabels, ...[...labels.values()].flat()]),
    scriptJs: liveClientJs,
  });
}

/**
 * GET /:owner/:name/pulls, and /changes: every change, for every
 * repository and every viewer — one row per pull in its studio word, who
 * made it, its labels, when it last moved, and the change itself as the
 * row's own link. Where a change lives, its diff and its reviews are one
 * step deeper, on the change. Narrowed as `tellsList` is.
 */
export async function changesList(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const db = ctx.app.db;
  const base = repoBase(repo);
  const f = readFacets(ctx);
  const { options, wordCtx } = listRead(ctx, repo, f);

  const fetched = listPulls(db, repo.id, options);
  const words = await Promise.all(
    fetched.map((pull) => pullWord(wordCtx, pull)),
  );
  const answered = tellsAnswered(db, repo.id, fetched);
  const labels = labelsForIssues(db, fetched.map((pull) => pull.id));
  const repoLabels = listLabels(db, repo.id);
  const rows = fetched
    .map((pull, i) => ({ pull, info: words[i]! }))
    .filter((r) => shown(r.info.word, f));

  const list =
    rows.length === 0
      ? empty({
          icon: "pull",
          title: "Nothing here",
          note: emptyNote(f.word, "No change", "Nothing open. A change is the crew's proposed edit to your app; the crew opens them as it works."),
        })
      : listCard(
          rows.map(({ pull, info }) =>
            row({
              href: changeHref(base, pull.number),
              nav: true,
              lead: avatar(pull.authorName),
              title: titled(pull.title, labels.get(pull.id)),
              titleAttr: pull.title,
              meta: html`${pull.originAuthor
                ? originTag(pull.originAuthor, originGlyph(repo))
                : pull.authorName} · ${info.note} ·
              ${when(answered.get(pull.number), (t) => html`${tellLine(base, t)} · `)}${time(pull.updatedAt)}`,
              trail: wordBadge(info.word),
            }),
          ),
        );
  const lastNumber = fetched[fetched.length - 1]?.number;
  // See `tellsList`: `/changes` or `/pulls`, whichever reached this page.
  const listBase = ctx.url.pathname;

  const body = html`${repoHeader(ctx, repo, "pulls")}
    <div class="mt">
      ${wordFilterBar(
        (word) => facetHref(listBase, f, { word }),
        f.word,
        f.word === undefined && f.state === "open",
      )}
      ${facetChips(listBase, f, repoLabels)} ${list}
      ${pager(
        fetched.length === LIST_PAGE && lastNumber !== undefined
          ? { next: facetHref(listBase, f, {}, lastNumber) }
          : {},
      )}
    </div>
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: pageTitle("changes", repo, true),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: labelCss([...repoLabels, ...[...labels.values()].flat()]),
    scriptJs: liveClientJs,
  });
}

/**
 * GET /:owner/:name/runs in the studio: every run, one row per run in its
 * studio word — who ran it, when it last moved, and the transcript as the
 * row's own link. `?word=` narrows it; `?mode=dev` reads dev's list,
 * unchanged.
 */
export async function studioRuns(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const filter = readWordFilter(ctx);
  const cursor = ctx.url.searchParams.get("cursor") ?? undefined;

  const fetched = listRuns(db, repo.id, {
    kind: "agent",
    limit: LIST_PAGE,
    ...(cursor ? { cursor } : {}),
  });
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
    history: servingHistory(),
  };
  const actors = actorsFor(ctx, fetched);
  const issues = issuesFor(ctx, fetched);
  const words = await Promise.all(fetched.map((run) => runWord(wordCtx, run)));
  const rows = fetched
    .map((run, i) => ({ run, info: words[i]! }))
    .filter((r) => inWordFilter(r.info.word, filter));

  const list =
    rows.length === 0
      ? empty({
          icon: "bot",
          title: "Nothing here",
          note: emptyNote(filter, "No run", "Nothing open. A run is one go the crew takes at a job; each one shows up here."),
        })
      : listCard(
          rows.map(({ run, info }) => {
            const who =
              run.actorId === null
                ? "crew"
                : (actors.get(run.actorId)?.username ?? "crew");
            return row({
              href: `${base}/runs/${run.id}`,
              nav: true,
              lead: avatar(who),
              title: runTitleFrom(run, actors, issues),
              meta: html`${who} · ${info.note} ·
              ${time(run.finishedAt ?? run.createdAt)}`,
              trail: wordBadge(info.word),
            });
          }),
        );
  const last = fetched[fetched.length - 1];

  const body = html`${repoHeader(ctx, repo, "app", { compact: true })}
    <div class="mt">
      ${wordFilterBar(
        (word) => (word ? `${base}/runs?word=${word}` : `${base}/runs`),
        filter,
        filter === undefined,
      )}
      ${list}
      ${pager(
        fetched.length === LIST_PAGE && last !== undefined
          ? { next: pagedHref(`${base}/runs`, filter, last.id) }
          : {},
      )}
    </div>
    <p class="muted small mt">
      <a href="${base}/runs?mode=dev">${icon("code")}See dev's list</a> —
      deploys and checks alongside the crew's runs, dev's own way.
    </p>
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: pageTitle("runs", repo, true),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    scriptJs: liveClientJs,
  });
}
