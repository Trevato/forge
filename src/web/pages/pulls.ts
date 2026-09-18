/**
 * The pull-request list and the compose form. A pull is an issue with a base
 * and a head, so the list is the issue list with one more state (merged) and
 * a branch pair in the metadata line; the compose form is the only place in
 * the product that reaches across two repositories.
 */

import { openPull } from "../../actions/pulls.ts";
import { getAppByRepo } from "../../core/apps.ts";
import {
  commentCounts,
  issueCounts,
  labelsForIssues,
  countComments,
  labelsFor,
  listLabels,
  type Label,
} from "../../core/issues.ts";
import { listPulls, type Pull } from "../../core/pulls.ts";
import { reviewSummary, type ReviewSummary } from "../../core/reviews.ts";
import { getRepoById, type Repo } from "../../core/repos.ts";
import { listRefs } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
  stickyAction,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  badge,
  btn,
  card,
  empty,
  icon,
  labelCss,
  listCard,
  pager,
  seg,
  time,
  originTag,
  userTag,
  field as formField,
} from "../ui.ts";
import { refSet } from "./refs.ts";
import { threadRow } from "./issues.ts";
import { studioChanges } from "./studio.ts";
import { originGlyph } from "./thread.ts";

const PER_PAGE = 25;

/** open | closed | merged — the one place the third state is derived. */
export function pullState(pull: Pull): "open" | "closed" | "merged" {
  if (pull.mergedAt !== null) return "merged";
  return pull.state === "closed" ? "closed" : "open";
}

// ---- the list ----

/**
 * Where each pull on this page stands, review-wise.
 *
 * A verdict only counts against the commit that is head *now*, and the row's
 * `head_oid` is the snapshot taken when the pull opened — so the live tips
 * are read in one `for-each-ref` for the whole page rather than a `rev-parse`
 * per row.
 *
 * The summaries themselves are still one query per pull: `core/reviews.ts`
 * has no grouped twin of `reviewSummary`, and this adapter has no business
 * writing SQL. Bounded by the page size (25), and the gap to close is a
 * `reviewSummariesFor(ids, heads)` beside `commentCounts`.
 */
async function verdictsFor(
  ctx: Ctx,
  repo: Repo,
  pulls: readonly Pull[],
): Promise<Map<string, ReviewSummary>> {
  const out = new Map<string, ReviewSummary>();
  // Only an open pull has a review still to satisfy; a closed or merged row
  // wears its own state badge and pays for nothing here.
  const open = pulls.filter((p) => p.state === "open" && p.mergedAt === null);
  if (open.length === 0) return out;
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const refs = await listRefs(dir, "refs/");
  const tips = new Map(refs.ok ? refs.value.map((r) => [r.name, r.oid]) : []);
  for (const pull of open) {
    const head =
      (pull.crossRepo
        ? tips.get(`refs/pull/${pull.number}/head`)
        : tips.get(`refs/heads/${pull.headBranch}`)) ?? pull.headOid;
    out.set(pull.id, reviewSummary(ctx.app.db, pull.id, head));
  }
  return out;
}

/**
 * The row's review mark. Only ever three answers, because a list is a place
 * to spot the one pull that needs you, not to read the whole record: it is
 * approved, somebody wants changes, or nobody has said yet.
 */
function verdictMark(summary: ReviewSummary | undefined): Html {
  if (summary === undefined) return html``;
  if (summary.changesRequested > 0)
    return badge("Changes requested", { icon: "alert", tone: "danger" });
  if (summary.approvals > 0)
    return badge(
      `${summary.approvals} approval${summary.approvals === 1 ? "" : "s"}`,
      { icon: "check", tone: "success" },
    );
  return html`<span class="badge verdict-stale"
    >${icon("eye")}Needs review</span
  >`;
}

// GET /:owner/:name/pulls
export async function pullsList(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  // In the studio "every change" is the pull list in the studio's own
  // words — the same rule `pullPage` follows for one change. `?mode=dev` is
  // the one-off way to dev's list without switching the browser.
  const studio =
    ctx.mode === "studio" && ctx.url.searchParams.get("mode") !== "dev";
  if (studio) {
    const record = getAppByRepo(ctx.app.db, repo.id);
    if (record !== undefined) return await studioChanges(ctx, repo, record);
  }
  const base = repoBase(repo);
  const db = ctx.app.db;
  const params = ctx.url.searchParams;
  const raw_ = params.get("state");
  const state = raw_ === "closed" ? "closed" : raw_ === "all" ? "all" : "open";
  const q = params.get("q") ?? "";
  const author = params.get("author") ?? "";
  const label = params.get("label") ?? "";
  const rawCursor = Number(params.get("cursor"));
  const cursor =
    Number.isSafeInteger(rawCursor) && rawCursor > 0 ? rawCursor : undefined;

  const pulls = listPulls(db, repo.id, {
    state,
    limit: PER_PAGE,
    ...(label !== "" ? { label } : {}),
    ...(author !== "" ? { author } : {}),
    ...(q !== "" ? { query: q } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  // Two grouped reads for the page, never two per row.
  const ids = pulls.map((pull) => pull.id);
  const labels = labelsForIssues(db, ids);
  const comments = commentCounts(db, ids);
  const verdicts = await verdictsFor(ctx, repo, pulls);
  const rows = pulls.map((pull) => ({
    pull,
    labels: labels.get(pull.id) ?? [],
    comments: comments.get(pull.id) ?? 0,
    verdict: verdicts.get(pull.id),
  }));
  // One pass over the covering index gives both numbers the seg control shows.
  const counts = issueCounts(db, repo.id, "pull");

  const href = (patch: Record<string, string>, next?: number) => {
    const p = new URLSearchParams();
    const s = patch.state ?? state;
    if (s !== "open") p.set("state", s);
    const l = patch.label ?? label;
    if (l !== "") p.set("label", l);
    const a = patch.author ?? author;
    if (a !== "") p.set("author", a);
    const query = patch.q ?? q;
    if (query !== "") p.set("q", query);
    if (next !== undefined) p.set("cursor", String(next));
    const text = p.toString();
    return text === "" ? `${base}/pulls` : `${base}/pulls?${text}`;
  };

  const newPull = ctx.auth.user
    ? btn("New pull request", {
        href: `${base}/pulls/new`,
        variant: "primary",
        icon: "pull",
        shortcut: "c",
      })
    : btn("Sign in to open one", { href: "/signin" });

  const list =
    rows.length === 0
      ? empty({
          icon: "pull",
          title:
            state === "closed"
              ? "No closed pull requests"
              : state === "all"
                ? "No pull requests yet"
                : "No open pull requests",
          note: "A pull request is how a branch asks to become the main line.",
          action: newPull,
        })
      : listCard(
          rows.map(({ pull, labels, comments, verdict }) =>
            threadRow(
              base,
              "pulls",
              pull,
              labels,
              pullState(pull),
              html`#${pull.number}
                <span class="mono"
                  >${pull.headBranch} → ${pull.baseBranch}</span
                >
                · opened ${time(pull.createdAt)} by
                ${pull.originAuthor
                  ? originTag(pull.originAuthor, originGlyph(repo))
                  : userTag(pull.authorName)}${when(
                  pullState(pull) === "open",
                  () => html` ${verdictMark(verdict)}`,
                )}`,
              comments,
            ),
          ),
        );

  const lastNumber = pulls[pulls.length - 1]?.number;
  const body = html`${repoHeader(ctx, repo, "pulls")}
    <div class="mt">
      <div class="filters">
        ${seg([
          {
            label: "Open",
            href: href({ state: "open" }),
            current: state === "open",
            count: counts.open,
          },
          {
            label: "Closed",
            href: href({ state: "closed" }),
            current: state === "closed",
            count: counts.closed,
          },
          {
            label: "All",
            href: href({ state: "all" }),
            current: state === "all",
          },
        ])}
        <form method="get" action="${base}/pulls" role="search">
          ${when(
            state !== "open",
            () => html`<input type="hidden" name="state" value="${state}" />`,
          )}
          <input
            class="input search"
            type="search"
            name="q"
            value="${q}"
            placeholder="Search titles"
            aria-label="Search titles"
          />
          ${btn("Search", { size: "sm", variant: "outline" })}
        </form>
      </div>
      ${list}
      ${pager(
        pulls.length === PER_PAGE && lastNumber !== undefined
          ? { next: href({}, lastNumber) }
          : {},
      )}
    </div>
    ${when(ctx.auth.user !== undefined, () => stickyAction(newPull))}
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: `Pull requests · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: labelCss([
      ...listLabels(db, repo.id),
      ...rows.flatMap((r) => r.labels),
    ]),
    scriptJs: liveClientJs,
  });
}

// ---- compose ----

interface ComposeValues {
  title: string;
  body: string;
  base: string;
  head: string;
}

function branchOptions(branches: string[], selected: string): Html {
  return html`${branches.map(
    (b) =>
      html`<option value="${b}" ${b === selected ? raw("selected") : null}>
        ${b}
      </option>`,
  )}`;
}

function composeForm(
  repo: Repo,
  parent: Repo | undefined,
  baseBranches: string[],
  headBranches: string[],
  values: ComposeValues,
  error?: string,
): Html {
  const cross = parent !== undefined;
  return html`<form method="post" action="${repoBase(repo)}/pulls/new">
    <input type="hidden" name="baseRepo" value="${cross ? "parent" : "self"}" />
    ${when(error, (message) => html`<p class="error-note">${message}</p>`)}
    ${card(
      html`<div class="field-row">
        <div class="field">
          <label for="f-base"
            >Base${when(
              parent,
              (p) =>
                html` <span class="muted mono">${p.ownerName}/${p.name}</span>`,
            )}</label
          >
          <select class="input" id="f-base" name="base">
            ${branchOptions(baseBranches, values.base)}
          </select>
        </div>
        <span class="muted">${icon("merge")}</span>
        <div class="field">
          <label for="f-head">Compare</label>
          <select class="input" id="f-head" name="head">
            ${branchOptions(headBranches, values.head)}
          </select>
        </div>
      </div>`,
      {
        head: html`${icon("branch")}
          <h2>Branches</h2>`,
      },
    )}
    <div class="mt">
      ${formField({
        label: "Title",
        name: "title",
        value: values.title,
        required: true,
        autofocus: true,
      })}
      ${formField({
        label: "Description",
        name: "body",
        type: "textarea",
        rows: 8,
        value: values.body,
        hint: "Markdown is supported.",
      })}
    </div>
    <div class="form-actions">
      ${btn("Create pull request", { variant: "primary", icon: "pull" })}
      ${btn("Cancel", { href: `${repoBase(repo)}/pulls`, variant: "ghost" })}
    </div>
  </form>`;
}

/** Resolve the two sides of a compose form: a fork proposes upstream by
 * default, `?self=1` keeps it inside this repo. */
async function composeContext(ctx: Ctx, repo: Repo, forceSelf: boolean) {
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const headBranches = (await refSet(dir)).branches;
  const parent =
    repo.forkParentId !== null && !forceSelf
      ? getRepoById(ctx.app.db, repo.forkParentId)
      : undefined;
  const baseBranches = parent
    ? (await refSet(repoDir(ctx.app.reposRoot, parent.ownerName, parent.name)))
        .branches
    : headBranches;
  const baseDefault = parent ? parent.defaultBranch : repo.defaultBranch;
  const headDefault =
    headBranches.find((b) => parent !== undefined || b !== baseDefault) ??
    headBranches[0] ??
    "";
  return { parent, baseBranches, headBranches, baseDefault, headDefault };
}

// GET /:owner/:name/pulls/new
export async function newPullPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const forceSelf = ctx.url.searchParams.get("self") !== null;
  const c = await composeContext(ctx, repo, forceSelf);
  // The branches page proposes a branch by linking here with it named, so
  // "New pull" from a row arrives with that row already chosen.
  const wantedHead = ctx.url.searchParams.get("head") ?? "";
  const wantedBase = ctx.url.searchParams.get("base") ?? "";
  const head = c.headBranches.includes(wantedHead) ? wantedHead : c.headDefault;
  const baseBranch = c.baseBranches.includes(wantedBase)
    ? wantedBase
    : c.baseDefault;
  const cross = c.parent !== undefined;
  const enough = cross
    ? c.baseBranches.length >= 1 && c.headBranches.length >= 1
    : c.headBranches.length >= 2;

  const body = html`${repoHeader(ctx, repo, "pulls", {
      compact: true,
      ownTitle: true,
    })}
    <h1 class="mt">New pull request</h1>
    <div class="narrow-wide mt">
      ${when(
        c.parent,
        (p) =>
          html`<p class="muted small mb">
            Proposing <strong>${repo.ownerName}/${repo.name}</strong> →
            <strong>${p.ownerName}/${p.name}</strong>.
            <a href="${repoBase(repo)}/pulls/new?self=1"
              >Open one within this fork instead.</a
            >
          </p>`,
      )}
      ${enough
        ? composeForm(repo, c.parent, c.baseBranches, c.headBranches, {
            title: "",
            body: "",
            base: baseBranch,
            head,
          })
        : empty({
            icon: "branch",
            title: "Push a second branch first",
            note: "A pull request compares two branches; this repository only has one.",
            action: btn("Back to code", { href: repoBase(repo) }),
          })}
    </div>`;
  return page({
    ctx,
    title: `New pull request · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
  });
}

const COMPOSE_ERRORS: Record<string, string> = {
  empty_title: "A title is required.",
  title_too_long: "That title is too long (256 characters at most).",
  body_too_long: "That description is too long (64 KB at most).",
  same_branch: "Base and compare branches must differ.",
  unknown_base: "That base branch does not exist.",
  unknown_head: "That compare branch does not exist.",
  nothing_to_merge: "The compare branch has no commits beyond base.",
  invalid_branch: "That branch name is not valid.",
};

// POST /:owner/:name/pulls/new
export async function newPullSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  // A fork proposing upstream creates the PR in the PARENT repo, with this
  // fork as the head. Otherwise it is a plain within-repo pull.
  const wantsParent = field(form, "baseRepo") === "parent";
  const parent =
    wantsParent && repo.forkParentId !== null
      ? getRepoById(ctx.app.db, repo.forkParentId)
      : undefined;
  const baseRepo = parent ?? repo;
  const values: ComposeValues = {
    title: field(form, "title"),
    body: field(form, "body"),
    base: field(form, "base"),
    head: field(form, "head"),
  };

  const created = await openPull(ctx.app, ctx.auth.user, baseRepo, {
    title: values.title,
    body: values.body,
    baseBranch: values.base,
    headBranch: values.head,
    ...(parent ? { headRepo: repo } : {}),
  });
  if (!created.ok) {
    // Re-render with everything the author typed still in place.
    const c = await composeContext(ctx, repo, !wantsParent);
    return page(
      {
        ctx,
        title: `New pull request · ${repo.name}`,
        crumbs: crumbsFor(repo),
        body: html`${repoHeader(ctx, repo, "pulls", {
            compact: true,
            ownTitle: true,
          })}
          <h1 class="mt">New pull request</h1>
          <div class="narrow-wide mt">
            ${composeForm(
              repo,
              c.parent,
              c.baseBranches,
              c.headBranches,
              values,
              COMPOSE_ERRORS[created.error] ??
                "That pull request could not be opened.",
            )}
          </div>`,
      },
      422,
    );
  }
  return flashTo(ctx, `${repoBase(baseRepo)}/pulls/${created.value.number}`, {
    message: `Pull request #${created.value.number} opened.`,
  });
}

export type { Pull, Label };
