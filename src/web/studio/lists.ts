/**
 * The forge's three lists — issues, pull requests, runs — and
 * the one filter bar they share: five words, each a link carrying `?word=`,
 * so what a person is looking at lives in the address and can be shared. A
 * row is the same word, note and time the thing's own page shows, because
 * every one of them is read through `tellWord`/`pullWord`/`runWord`. Each
 * list is bounded to one page. These are the only lists of issues and
 * pulls there are: every repository, every viewer, at `/issues` and
 * `/pulls`.
 */

import { sealedScope } from "../../core/sealed.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import {
  labelsForIssues,
  listIssues,
  listLabels,
  type Issue,
  type Label,
} from "../../core/issues.ts";
import { listPulls, openPullsClosing } from "../../core/pulls.ts";
import { stepsOfStored } from "../../flow/path.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { waitingCount } from "../../actions/reports.ts";

import { listRepoRuns } from "../../actions/runs.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInHref,
} from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { noteLine } from "./note.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  btn,
  disclosure,
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
import type { Run, RunState } from "../../core/runs.ts";
import { actorsFor, issuesFor, runTitleFrom } from "../pages/runs.ts";
import { originGlyph } from "../pages/thread.ts";
import { changeHref, PAGE_TITLES, pageTitle, tellHref } from "./nouns.ts";
import { knowMergeClosings, tellWords } from "./tell.ts";
import {
  pullWords,
  runWord,
  wordBadge,
  wordDot,
  wordText,
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
  if (word === "waiting" || word === "planned" || word === "silent" || word === "needs input")
    return "working";
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
  if (filter === "told") return `${subject} is waiting to be picked up.`;
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
  words: readonly WordFilter[] = WORD_FILTERS,
): Html {
  return html`<div class="bar mb">
    ${seg([
      { label: "Open", href: href(undefined), current: open },
      ...words.map((w) => ({
        // `told` is the state of an issue nobody has picked up: the filter
        // says so in those words, never as a noun for the issue (#3241).
        label: w === "told" ? "Not started" : w[0]!.toUpperCase() + w.slice(1),
        href: href(w),
        current: current === w,
      })),
    ])}
    ${when(trail, (t) => html`<span class="spacer"></span>${t}`)}
  </div>`;
}

/** The words a repository that is not an app can reach: nothing there is
 * told to a crew apart from being open, and no head is ever deployed for a
 * look — so those two are not offered as filters there. */
const PLAIN_FILTERS: readonly WordFilter[] = ["working", "shipped", "stopped"];

/** The words a pull or a run can carry, as a list links to them: every word
 * but *told*. `pullWord` never hands that word back, and `runWord` reaches a
 * pull's word only through `pullWord` — so on the changes and runs lists a
 * *Not started* filter could only ever land on an empty page (#175). The
 * tells list, built on `tellWord`, is the one that offers all five. */
const PULL_FILTERS: readonly WordFilter[] = WORD_FILTERS.filter(
  (w) => w !== "told",
);

const LIST_PAGE = 25;

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
function facetChips(
  base: string,
  f: ListFacets,
  labels: readonly Label[],
  fold = false,
): Html {
  const active = (
    [
      ["assignee", "has it"],
      ["author", "opened it"],
      ["q", "in the title"],
    ] as const
  ).filter(([name]) => f[name] !== "");
  // An older `?state=closed|all` address narrows the list without a word;
  // it shows as a chip like any other narrowing, so it can be seen and
  // cleared.
  const state =
    f.word === undefined && f.state !== "open"
      ? html`<a
          class="label"
          href="${facetHref(base, { ...f, state: "open" }, {})}"
          aria-current="true"
          title="Remove this filter"
          >${f.state === "closed" ? "closed" : "open and closed"} ✕</a
        >`
      : null;
  if (active.length === 0 && labels.length === 0 && state === null)
    return html``;
  const chosen = f.label.toLowerCase();
  const rest = labels.filter((l) => l.name.toLowerCase() !== chosen);
  const picked = labels.find((l) => l.name.toLowerCase() === chosen);
  return html`<div class="bar mb">
    ${state}
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
    ${when(
      picked,
      (l) => html`<a
        class="label lc-${l.color}"
        href="${facetHref(base, f, { label: "" })}"
        aria-current="true"
        title="Remove this filter"
        >${l.name} ✕</a
      >`,
    )}
    ${rest.length === 0
      ? null
      : !fold
        ? rest.map((l) => labelChip(l, facetHref(base, f, { label: l.name })))
        : disclosure(
          "Labels",
          html`<div class="bar">
            ${rest.map((l) => labelChip(l, facetHref(base, f, { label: l.name })))}
          </div>`,
          { small: true },
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
    viewer: ctx.auth.user,
  };
  return { options, record, wordCtx };
}

/**
 * Every action the issues list offers, as palette entries (Cmd-K): the
 * filters, the compose page and the outside reports. What the page shows
 * quietly is still one keystroke away.
 */
export function tellsListActions(o: {
  base: string;
  name: string;
  word: readonly WordFilter[];
  signedIn: boolean;
  reports: number;
  labels?: readonly string[];
}): { t: string; h: string; c: string }[] {
  const c = "This list";
  return [
    { t: `${o.name} — Open issues`, h: `${o.base}/issues`, c },
    ...o.word.map((w) => ({
      t: `${o.name} — Issues: ${w === "told" ? "Not started" : w}`,
      h: `${o.base}/issues?word=${w}`,
      c,
    })),
    ...(o.labels ?? []).map((l) => ({
      t: `${o.name} — Issues labelled ${l}`,
      h: `${o.base}/issues?label=${encodeURIComponent(l)}`,
      c,
    })),
    ...(o.signedIn ? [{ t: `${o.name} — New issue`, h: `${o.base}/issues/new`, c }] : []),
    ...(o.reports > 0
      ? [{ t: `${o.name} — Reports from outside`, h: `${o.base}/reports`, c }]
      : []),
  ];
}

/**
 * An issue's title is the writer's words, so inside `[data-tells]` a row wraps
 * them (a long word breaks anywhere) in place of the one-line ellipsis, and the
 * page never scrolls sideways at 390 px. No new class.
 */
export const TELLS_CSS = `[data-tells] { overflow-wrap: anywhere; }
[data-tells] .row-title, [data-tells] .row-meta { white-space: normal; overflow: visible; text-overflow: clip; }
[data-tells] .row { align-items: flex-start; }`;

/**
 * GET /:owner/:name/issues: every issue, for every
 * repository and every viewer — one row per issue in its studio word, who
 * has it, its labels, when it last moved, and the tell itself as the row's
 * own link. `?word=` narrows it, and so do `?label=`, `?assignee=`,
 * `?author=` and `?q=`. Bounded to one page: `tellWord` costs a few small
 * reads per row.
 */
export async function tellsList(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const db = ctx.app.db;
  const base = repoBase(repo);
  const f = readFacets(ctx);
  const { options, record, wordCtx } = listRead(ctx, repo, f);

  let at = performance.now();
  const fetched = listIssues(db, repo.id, {
    ...options,
    kind: "issue",
    ...sealedScope(db, repo, ctx.auth.user),
  }).filter(
    (issue) => issue.id !== repo.directionIssueId,
  );
  notePhase(ctx.request, "issues", performance.now() - at);
  at = performance.now();
  const closingPulls = openPullsClosing(db, repo.id);
  knowMergeClosings(
    wordCtx,
    repo.id,
    fetched.filter((i) => i.state === "closed").map((i) => i.number),
  );
  notePhase(ctx.request, "closing", performance.now() - at);
  at = performance.now();
  const words = (await tellWords(wordCtx, repo, fetched, closingPulls)).map(
    (word, i) => word ?? closedWord(fetched[i]!),
  );
  notePhase(ctx.request, "words", performance.now() - at);
  at = performance.now();
  const labels = labelsForIssues(db, fetched.map((issue) => issue.id));
  const repoLabels = listLabels(db, repo.id);
  notePhase(ctx.request, "labels", performance.now() - at);
  at = performance.now();
  const rows = fetched
    .map((issue, i) => ({ issue, info: words[i]! }))
    .filter((r) => shown(r.info.word, f));

  const list =
    rows.length === 0
      ? empty({
          icon: "issue",
          title: emptyNote(
            f.word,
            "No issue",
            record === undefined
              ? "Nothing open."
              : "Nothing open. Tell the crew what you want.",
          ),
        })
      : listCard(
          rows.map(({ issue, info }) =>
            row({
              href: tellHref(base, issue.number),
              nav: true,
              lead: wordDot(info.word, info.note),
              title: titled(issue.title, labels.get(issue.id)),
              titleAttr: issue.title,
              meta: html`${wordText(info.word)}${when(
                issue.originAuthor,
                (login) => html`${originTag(login, originGlyph(repo))} · `,
              )}${time(issue.updatedAt)}`,
            }),
          ),
          { extra: "bare" },
        );
  const lastNumber = fetched[fetched.length - 1]?.number;
  // Self-links follow the address that reached this page.
  const listBase = ctx.url.pathname;
  // The one verb besides opening a row: say what you want. It posts from
  // `/issues/new`, the compose page, in the words the repository has.
  const compose = when(ctx.auth.user, () =>
    btn(PAGE_TITLES.compose, {
      href: `${base}/issues/new`,
      size: "sm",
      variant: "primary",
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
      ? btn(`${waiting} from outside`, {
          href: `${base}/reports`,
          size: "sm",
          variant: "ghost",
        })
      : undefined;
  // Signed out, the way in: sign in to open one, or report a problem
  // without an account where the repository is public.
  const signIn = when(ctx.auth.user === undefined && outside !== undefined, () =>
    btn("Sign in to open an issue", {
      href: signInHref(ctx),
      size: "sm",
      variant: "ghost",
    }),
  );
  const verbs =
    ctx.auth.user === undefined && outside === undefined
      ? undefined
      : html`${reports ?? null} ${compose} ${outside ?? null} ${signIn}`;

  const body = html`${repoHeader(ctx, repo, "issues")}
    <div class="mt" data-tells>
      ${wordFilterBar(
        (word) => facetHref(listBase, f, { word }),
        f.word,
        f.word === undefined && f.state === "open",
        verbs,
        record === undefined ? PLAIN_FILTERS : WORD_FILTERS,
      )}
      ${facetChips(listBase, f, repoLabels)} ${list}
      ${pager(
        fetched.length === LIST_PAGE && lastNumber !== undefined
          ? { next: facetHref(listBase, f, {}, lastNumber) }
          : {},
      )}
    </div>
    ${liveMount({ repo: base })}`;

  const response = page({
    ctx,
    title: pageTitle("tells", repo, record !== undefined),
    crumbs: crumbsFor(repo),
    palette: [
      ...repoPalette(ctx, repo),
      ...tellsListActions({
        base,
        word: record === undefined ? PLAIN_FILTERS : WORD_FILTERS,
        name: `${repo.ownerName}/${repo.name}`,
        signedIn: ctx.auth.user !== undefined,
        reports: waiting,
        labels: repoLabels.map((l) => l.name),
      }),
    ],
    body,
    styleCss: `${TELLS_CSS}\n${labelCss([...repoLabels, ...[...labels.values()].flat()])}`,
    scriptJs: liveClientJs,
  });
  notePhase(ctx.request, "render", performance.now() - at);
  return response;
}

/**
 * A pull's title and branch are the writer's words, so inside `[data-pulls]`
 * a row wraps them (a long word breaks anywhere) in place of the list's
 * one-line ellipsis, and the page never scrolls sideways at 390 px. No new class.
 */
export const PULLS_CSS = `[data-pulls] { overflow-wrap: anywhere; }
[data-pulls] .row-title, [data-pulls] .row-meta { white-space: normal; overflow: visible; text-overflow: clip; }
[data-pulls] .row { align-items: flex-start; }`;

/**
 * GET /:owner/:name/pulls: every pull request, for every
 * repository and every viewer — one row per pull in its studio word, who
 * made it, its labels, when it last moved, and the change itself as the
 * row's own link. Where a change lives, its diff and its reviews are one
 * step deeper, on the change. Narrowed as `tellsList` is.
 */
export async function changesList(ctx: Ctx): Promise<Response> {
  const started = performance.now();
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const db = ctx.app.db;
  const base = repoBase(repo);
  const f = readFacets(ctx);
  const { options, record, wordCtx } = listRead(ctx, repo, f);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));

  let mark = performance.now();
  notePhase(ctx.request, "repo", mark - started);
  const lap = (name: string): void => {
    const now = performance.now();
    notePhase(ctx.request, name, now - mark);
    mark = now;
  };
  const fetched = listPulls(db, repo.id, {
    ...options,
    ...sealedScope(db, repo, ctx.auth.user),
  });
  lap("pulls");
  const words = await pullWords(wordCtx, fetched);
  lap("words");
  const labels = labelsForIssues(db, fetched.map((pull) => pull.id));
  const repoLabels = listLabels(db, repo.id);
  lap("labels");
  const rows = fetched
    .map((pull, i) => ({ pull, info: words[i]! }))
    // An open pull is always listed, whatever its word: the tab counts them all.
    .filter((r) => f.word === undefined || shown(r.info.word, f));

  // Only a stopped pull's row says why: the step's sentence, one clamped line.
  const stopped = stepsOfStored(
    db,
    repo,
    rows.filter((r) => r.info.word === "stopped").map((r) => r.pull),
  );

  const list =
    rows.length === 0
      ? empty({
          icon: "pull",
          title: emptyNote(
            f.word,
            "No pull request",
            "Nothing open.",
          ),
        })
      : listCard(
          rows.map(({ pull, info }) =>
            row({
              href: changeHref(base, pull.number),
              nav: true,
              lead: wordDot(info.word, info.note),
              title: titled(pull.title, labels.get(pull.id)),
              titleAttr: pull.title,
              meta: html`${wordText(info.word)}${when(info.word === "stopped" ? stopped.get(pull.id) : undefined, (step) => html`${noteLine(step.why)} · `)}${time(pull.updatedAt)}`,
            }),
          ),
        );
  const lastNumber = fetched[fetched.length - 1]?.number;
  // See `tellsList`.
  const listBase = ctx.url.pathname;

  const body = html`${repoHeader(ctx, repo, "pulls")}
    <div class="mt" data-pulls>
      ${wordFilterBar(
        (word) => facetHref(listBase, f, { word }),
        f.word,
        f.word === undefined && f.state === "open",
        undefined,
        record === undefined ? PLAIN_FILTERS : PULL_FILTERS,
      )}
      ${facetChips(listBase, f, repoLabels)} ${list}
      ${pager(
        fetched.length === LIST_PAGE && lastNumber !== undefined
          ? { next: facetHref(listBase, f, {}, lastNumber) }
          : {},
      )}
    </div>
    ${liveMount({ repo: base })}`;

  const res = page({
    ctx,
    title: pageTitle("changes", repo, record !== undefined),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: `${PULLS_CSS}\n${labelCss([...repoLabels, ...[...labels.values()].flat()])}`,
    scriptJs: liveClientJs,
  });
  lap("render");
  return res;
}

/** Which runs a list shows: all three kinds by default, or the one that
 * `?kind=` asks for — the narrowing dev's list offered, kept so a link
 * written to it keeps meaning what it said. */
type RunsKind = "agent" | "deploy" | "check";

function readRunsKind(ctx: Ctx): RunsKind | undefined {
  const raw = ctx.url.searchParams.get("kind");
  return raw === "agent" || raw === "deploy" || raw === "check"
    ? raw
    : undefined;
}

/** The states `?state=` narrows to; anything else is ignored. */
const RUN_STATES: readonly RunState[] = [
  "queued",
  "running",
  "ok",
  "failed",
  "cancelled",
];

function readRunsState(ctx: Ctx): RunState | undefined {
  const raw = ctx.url.searchParams.get("state");
  return RUN_STATES.find((s) => s === raw);
}

/** The row of state links above the list, in the words the badges use. */
const STATE_LINKS: readonly [RunState | undefined, string][] = [
  [undefined, "All"],
  ["failed", "Failed"],
  ["running", "Running"],
  ["ok", "Succeeded"],
];

/** The runs list's own address with a word, a kind, a state and a cursor. */
function runsHref(
  base: string,
  kind: RunsKind | undefined,
  word: WordFilter | undefined,
  cursor?: string,
  state?: RunState,
): string {
  const params = new URLSearchParams();
  if (kind !== undefined) params.set("kind", kind);
  if (state !== undefined) params.set("state", state);
  if (word !== undefined) params.set("word", word);
  if (cursor !== undefined) params.set("cursor", cursor);
  const text = params.toString();
  return text === "" ? `${base}/runs` : `${base}/runs?${text}`;
}

/** Whether a run is doing something at this moment — the only runs under
 * Working. A deploy is not counted: the flow report's stages are builders,
 * reviewers and checks, and the tab's count is held to theirs. */
export function isWorkingNow(run: Run): boolean {
  return run.state === "running" && run.kind !== "deploy";
}

/** Whether a run belongs on the page asked for. Working is exactly the
 * runs running now. With no word chosen a check or a deploy that finished
 * is news too, and an explicit `?state=` shows every run it fetched: the
 * default list is the whole story, newest first. Otherwise the word rules. */
export function onRunsList(
  run: Run,
  word: Word,
  filter: WordFilter | undefined,
  state: RunState | undefined,
): boolean {
  if (filter === "working") return isWorkingNow(run);
  if (filter === undefined && (run.kind !== "agent" || state !== undefined))
    return true;
  return inWordFilter(word, filter);
}

const RUNS_KIND_WORDS: Record<RunsKind, string> = {
  agent: "Agent runs",
  deploy: "Deploys",
  check: "Checks",
};

/**
 * GET /:owner/:name/runs: every run, for every repository and every viewer,
 * one row per run in its studio word — who ran it, when it last moved, and
 * the transcript as the row's own link. Agent runs, checks and deploys
 * together, newest first, by default; `?kind=agent|deploy|check` narrows to
 * one, from the three links under the list. `?word=` narrows any of them,
 * from the changes list's words (`PULL_FILTERS`). The header is the full one
 * the tells and changes lists carry, description included.
 */
export async function runsListPage(ctx: Ctx, repo: Repo): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const filter = readWordFilter(ctx);
  const kind = readRunsKind(ctx);
  const state = readRunsState(ctx);
  const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));

  // A private app's runs are for those who may enter it, and a sealed
  // report's for those who may see it (`listRepoRuns`).
  const reading = performance.now();
  const listed = listRepoRuns(ctx.app, ctx.auth.user, repo, {
    kind,
    // Working is what runs now: read only the running ones, so the page
    // is not spent on finished rows it would drop.
    state: state ?? (filter === "working" ? "running" : undefined),
    limit: LIST_PAGE,
    ...(cursor ? { cursor } : {}),
  });
  const fetched = listed.ok ? listed.value : [];
  const record = getAppByRepo(db, repo.id);
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
    history: servingHistory(),
    viewer: ctx.auth.user,
  };
  const actors = actorsFor(ctx, fetched);
  const issues = issuesFor(ctx, fetched);
  const words = await Promise.all(fetched.map((run) => runWord(wordCtx, run)));
  const rows = fetched
    .map((run, i) => ({ run, info: words[i]! }))
    .filter(
      (r) => onRunsList(r.run, r.info.word, filter, state),
    );

  notePhase(ctx.request, "runs", performance.now() - reading);

  const rendering = performance.now();
  const list =
    rows.length === 0
      ? empty({
          icon: "bot",
          title: emptyNote(
            filter,
            "No run",
            "Nothing open.",
          ),
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
              lead:
                run.kind === "agent"
                  ? avatar(who)
                  : icon(run.kind === "check" ? "check" : "rocket"),
              title: runTitleFrom(run, actors, issues),
              meta:
                run.state === "failed"
                  ? html`${noteLine(info.note)} · ${time(run.finishedAt ?? run.createdAt)}`
                  : run.state === "queued" && run.notBefore !== null
                    ? html`${noteLine("paused on a limit, resumes soon")} · ${time(run.createdAt)}`
                  : time(run.finishedAt ?? run.createdAt),
              trail: wordBadge(info.word),
            });
          }),
          { extra: "bare" },
        );
  const last = fetched[fetched.length - 1];

  const body = html`${repoHeader(ctx, repo, "runs")}
    <div class="mt">
      <nav aria-label="Run state">
        ${seg(
          STATE_LINKS.map(([s, label]) => ({
            label,
            href: runsHref(base, kind, filter, undefined, s),
            current: s === state,
          })),
        )}
      </nav>
      ${wordFilterBar(
        (word) => runsHref(base, kind, word, undefined, state),
        filter,
        filter === undefined,
        undefined,
        PULL_FILTERS,
      )}
      ${list}
      ${pager(
        fetched.length === LIST_PAGE && last !== undefined
          ? { next: runsHref(base, kind, filter, last.id, state) }
          : {},
      )}
    </div>
    <p class="muted small mt">
      Show ${(["agent", "deploy", "check"] as const).map(
        (k, i) =>
          html`${i > 0 ? " · " : ""}${k === kind
              ? html`<strong>${RUNS_KIND_WORDS[k]}</strong>`
              : html`<a href="${runsHref(base, k, undefined)}"
                  >${RUNS_KIND_WORDS[k]}</a
                >`}`,
      )}${kind === undefined
        ? null
        : html` · <a href="${runsHref(base, undefined, undefined)}">All</a>`}
    </p>
    ${liveMount({ repo: base })}`;

  const res = page({
    ctx,
    title: pageTitle("runs", repo, true),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    scriptJs: liveClientJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}
