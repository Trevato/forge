/**
 * The pull-request compose form, and the one place a pull's third state is
 * derived. The compose form is the only place in the product that reaches
 * across two repositories; the list is the studio's (`changesList`,
 * `src/web/studio/lists.ts`).
 */

import { openPull } from "../../actions/pulls.ts";
import { VERIFY_FIRST } from "../../actions/verify_words.ts";
import { GUEST_REFUSALS } from "../../core/contribute.ts";
import { BODY_TOO_LONG, TITLE_TOO_LONG } from "../../actions/thread_limits_words.ts";
import type { Label } from "../../core/issues.ts";
import type { Pull } from "../../core/pulls.ts";
import {
  forkParentFor,
  type Repo,
} from "../../core/repos.ts";
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
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, empty, icon, field as formField } from "../ui.ts";
import { refSet } from "./refs.ts";

/** open | closed | merged — the one place the third state is derived. */
export function pullState(pull: Pull): "open" | "closed" | "merged" {
  if (pull.mergedAt !== null) return "merged";
  return pull.state === "closed" ? "closed" : "open";
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
  /** Offer the deliberate yes to publishing a sealed fix's branch (`sealed_in_public`). */
  confirmPublic = false,
): Html {
  const cross = parent !== undefined;
  return html`<form method="post" action="${repoBase(repo)}/pulls/new">
    <input type="hidden" name="baseRepo" value="${cross ? "parent" : "self"}" />
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
        ...(error ? { error } : {}),
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
    ${confirmPublic
      ? html`<label class="field mt">
          <input type="checkbox" name="confirm_public" value="1" />
          Publish this branch anyway: everyone who can read
          ${repo.ownerName}/${repo.name} sees the fix, and with it where the
          hole is.
        </label>`
      : null}
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
  const parent = forceSelf
    ? undefined
    : forkParentFor(ctx.app.db, repo, ctx.auth.user);
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
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const forceSelf = ctx.url.searchParams.get("self") !== null;
  const comparing = performance.now();
  const c = await composeContext(ctx, repo, forceSelf);
  notePhase(ctx.request, "compare", performance.now() - comparing);
  const rendering = performance.now();
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
  const response = page({
    ctx,
    title: `New pull request · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const COMPOSE_ERRORS: Record<string, string> = {
  ...GUEST_REFUSALS,
  unverified: VERIFY_FIRST,
  empty_title: "A title is required.",
  title_too_long: TITLE_TOO_LONG,
  body_too_long: BODY_TOO_LONG,
  same_branch: "Base and compare branches must differ.",
  unknown_base: "That base branch does not exist.",
  unknown_head: "That compare branch does not exist.",
  nothing_to_merge: "The compare branch has no commits beyond base.",
  invalid_branch: "That branch name is not valid.",
  sealed_in_public:
    "This fixes a sealed security report, and this branch is public: anyone can read the fix, and with it where the hole is. Work on it privately — open the report and choose “Work on this privately” — or publish anyway below.",
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
  const parent = wantsParent
    ? forkParentFor(ctx.app.db, repo, ctx.auth.user)
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
    ...(field(form, "confirm_public") === "1" ? { confirmPublic: true } : {}),
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
              created.error === "sealed_in_public",
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
