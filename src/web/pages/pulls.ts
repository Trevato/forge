/**
 * The pull-request list and the compose form. A pull is an issue with a base
 * and a head, so the list is the issue list with one more state (merged) and
 * a branch pair in the metadata line; the compose form is the only place in
 * the product that reaches across two repositories.
 */

import { openPull } from "../../actions/pulls.ts";
import {
  countIssues,
  countComments,
  labelsFor,
  listLabels,
  type Label,
} from "../../core/issues.ts";
import { listPulls, type Pull } from "../../core/pulls.ts";
import { getRepoById, type Repo } from "../../core/repos.ts";
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
  btn,
  card,
  empty,
  icon,
  labelCss,
  listCard,
  pager,
  seg,
  time,

  userTag,
  field as formField,
} from "../ui.ts";
import { refSet } from "./refs.ts";
import { threadRow } from "./issues.ts";

const PER_PAGE = 25;

/** open | closed | merged — the one place the third state is derived. */
export function pullState(pull: Pull): "open" | "closed" | "merged" {
  if (pull.mergedAt !== null) return "merged";
  return pull.state === "closed" ? "closed" : "open";
}

// ---- the list ----

// GET /:owner/:name/pulls
export function pullsList(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
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
  const rows = pulls.map((pull) => ({
    pull,
    labels: labelsFor(db, pull.id),
    comments: countComments(db, pull.id),
  }));
  const counts = {
    open: countIssues(db, repo.id, "pull", "open"),
    closed: countIssues(db, repo.id, "pull", "closed"),
  };

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
          rows.map(({ pull, labels, comments }) =>
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
                ${userTag(pull.authorName)}`,
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
  const cross = c.parent !== undefined;
  const enough = cross
    ? c.baseBranches.length >= 1 && c.headBranches.length >= 1
    : c.headBranches.length >= 2;

  const body = html`${repoHeader(ctx, repo, "pulls", { compact: true, ownTitle: true })}
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
            base: c.baseDefault,
            head: c.headDefault,
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
        body: html`${repoHeader(ctx, repo, "pulls", { compact: true, ownTitle: true })}
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
