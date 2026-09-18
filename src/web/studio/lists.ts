/**
 * The studio's three lists — everything told, every change, every run — and
 * the one filter bar they share: five words, each a link carrying `?word=`,
 * so what a person is looking at lives in the address and can be shared. A
 * row is the same word, note and time the thing's own page shows, because
 * every one of them is read through `tellWord`/`pullWord`/`runWord`. Each
 * list is bounded to one page; `?mode=dev` reads dev's list, unchanged.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import { listIssues, type Issue } from "../../core/issues.ts";
import { listPulls, openPullsClosing } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { listRuns } from "../../core/runs.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  empty,
  icon,
  listCard,
  pager,
  row,
  seg,
  time,
} from "../ui.ts";
import { actorsFor, issuesFor, runTitleFrom } from "../pages/runs.ts";
import { studioCss } from "./style.ts";
import { tellWord } from "./tell.ts";
import {
  pullWord,
  runWord,
  wordBadge,
  type Word,
  type WordCtx,
} from "./words.ts";

/** The five words a studio list filters by. `waiting` and `planned` are
 * still moving, so they fold into `working` — the one place the seven-word
 * vocabulary above buckets down to the five a list links to. */
type WordFilter = "told" | "working" | "look" | "shipped" | "stopped";

const WORD_FILTERS: readonly WordFilter[] = [
  "told",
  "working",
  "look",
  "shipped",
  "stopped",
];

function listBucket(word: Word): WordFilter {
  return word === "waiting" || word === "planned" ? "working" : word;
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

/** A filter bar of five words, each a link carrying `?word=` — never a
 * form, so the filter lives in the address and can be shared. No filter
 * reads as "Open": what is open and moving. */
function wordFilterBar(base: string, current: WordFilter | undefined): Html {
  return html`<div class="filters mb">
    ${seg([
      { label: "Open", href: base, current: current === undefined },
      ...WORD_FILTERS.map((w) => ({
        label: w[0]!.toUpperCase() + w.slice(1),
        href: `${base}?word=${w}`,
        current: current === w,
      })),
    ])}
  </div>`;
}

const LIST_PAGE = 25;

/** `?word=` carried onto a `cursor` link, so paging keeps the filter. */
function pagedHref(base: string, filter: WordFilter | undefined, cursor: string): string {
  return `${base}?${filter ? `word=${filter}&` : ""}cursor=${cursor}`;
}

/**
 * GET /:owner/:name/issues in the studio: everything told, one row per
 * issue in its studio word — who has it, when it last moved, and the tell
 * itself as the row's own link. No labels, no milestones. `?word=` narrows
 * it; `?mode=dev` reads dev's list, unchanged. Bounded to one page: `tellWord`
 * costs a few small reads per row, the trade the pull list already makes
 * for its own check summaries (`verdictsFor`, pulls.ts).
 */
export async function studioTells(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const filter = readWordFilter(ctx);
  const state = filter === "shipped" || filter === "stopped" ? "closed" : "open";
  const rawCursor = Number(ctx.url.searchParams.get("cursor"));
  const cursor =
    Number.isSafeInteger(rawCursor) && rawCursor > 0 ? rawCursor : undefined;

  const fetched = listIssues(db, repo.id, {
    kind: "issue",
    state,
    limit: LIST_PAGE,
    ...(cursor !== undefined ? { cursor } : {}),
  }).filter((issue) => issue.id !== repo.directionIssueId);
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
  };
  const closingPulls = openPullsClosing(db, repo.id);
  const words = await Promise.all(
    fetched.map((issue) =>
      tellWord(wordCtx, repo, issue, closingPulls.get(issue.number)),
    ),
  );
  const rows = fetched
    .map((issue, i) => ({ issue, info: words[i] }))
    .filter(
      (r): r is { issue: Issue; info: { word: Word; note: string } } =>
        r.info !== undefined && inWordFilter(r.info.word, filter),
    );

  const list =
    rows.length === 0
      ? empty({
          icon: "issue",
          title: "Nothing here",
          note: "Nothing told matches this filter yet.",
        })
      : listCard(
          rows.map(({ issue, info }) =>
            row({
              href: `${base}/issues/${issue.number}`,
              nav: true,
              lead: avatar(issue.assigneeName ?? "crew"),
              title: issue.title,
              meta: html`${issue.assigneeName
                ? html`${issue.assigneeName} · `
                : null}${info.note} · ${time(issue.updatedAt)}`,
              trail: wordBadge(info.word),
            }),
          ),
        );
  const lastNumber = fetched[fetched.length - 1]?.number;

  const body = html`${repoHeader(ctx, repo, "issues")}
    <div class="mt">
      ${wordFilterBar(`${base}/issues`, filter)} ${list}
      ${pager(
        fetched.length === LIST_PAGE && lastNumber !== undefined
          ? { next: pagedHref(`${base}/issues`, filter, String(lastNumber)) }
          : {},
      )}
    </div>
    <p class="muted small mt">
      <a href="${base}/issues?mode=dev">${icon("code")}See dev's list</a> —
      labels, milestones and the dependency form, dev's own way.
    </p>
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: `Everything told · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: studioCss,
    scriptJs: liveClientJs,
  });
}

/**
 * GET /:owner/:name/pulls in the studio: every change, one row per pull in
 * its studio word — who made it, when it last moved, and the change itself
 * as the row's own link. No branch names, no diff. `?word=` narrows it;
 * `?mode=dev` reads dev's list, unchanged.
 */
export async function studioChanges(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const filter = readWordFilter(ctx);
  const state = filter === "shipped" || filter === "stopped" ? "closed" : "open";
  const rawCursor = Number(ctx.url.searchParams.get("cursor"));
  const cursor =
    Number.isSafeInteger(rawCursor) && rawCursor > 0 ? rawCursor : undefined;

  const fetched = listPulls(db, repo.id, {
    state,
    limit: LIST_PAGE,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
  };
  const words = await Promise.all(
    fetched.map((pull) => pullWord(wordCtx, pull)),
  );
  const rows = fetched
    .map((pull, i) => ({ pull, info: words[i]! }))
    .filter((r) => inWordFilter(r.info.word, filter));

  const list =
    rows.length === 0
      ? empty({
          icon: "pull",
          title: "Nothing here",
          note: "Nothing matches this filter yet.",
        })
      : listCard(
          rows.map(({ pull, info }) =>
            row({
              href: `${base}/pulls/${pull.number}`,
              nav: true,
              lead: avatar(pull.authorName),
              title: pull.title,
              meta: html`${pull.authorName} · ${info.note} ·
              ${time(pull.updatedAt)}`,
              trail: wordBadge(info.word),
            }),
          ),
        );
  const lastNumber = fetched[fetched.length - 1]?.number;

  const body = html`${repoHeader(ctx, repo, "pulls")}
    <div class="mt">
      ${wordFilterBar(`${base}/pulls`, filter)} ${list}
      ${pager(
        fetched.length === LIST_PAGE && lastNumber !== undefined
          ? { next: pagedHref(`${base}/pulls`, filter, String(lastNumber)) }
          : {},
      )}
    </div>
    <p class="muted small mt">
      <a href="${base}/pulls?mode=dev">${icon("code")}See dev's list</a> —
      branch names and the diff, dev's own way.
    </p>
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: `Every change · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: studioCss,
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
          note: "Nothing matches this filter yet.",
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
      ${wordFilterBar(`${base}/runs`, filter)} ${list}
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
    title: `Every run · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: studioCss,
    scriptJs: liveClientJs,
  });
}
