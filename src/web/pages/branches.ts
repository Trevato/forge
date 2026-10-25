/**
 * Branches, as a page.
 *
 * The ref switcher tells you what exists; this tells you what is *going on* —
 * how far each branch has drifted from the default, which one is protected,
 * what landed on it last, and the two verbs a branch list exists for: open a
 * pull from it, or delete it.
 *
 * The arithmetic comes from `git/branches.ts` (`listBranches`), which caps
 * its comparisons; the mutations go through `actions/branches.ts`, which is
 * also what makes a mirrored repository ask its origin first. Nothing here
 * touches a ref itself.
 *
 * A live browse gets the same page without the verbs: an origin's branches
 * are readable and nothing more, which is the whole rule of a live browse.
 */

import { createBranch, deleteBranch } from "../../actions/branches.ts";
import type { Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhaseAsync } from "../../core/route_timing.ts";
import { listBranches, type BranchInfo } from "../../git/branches.ts";
import { commitLog, type Commit } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import type { RepoScope } from "../scope.ts";
import { loadRepo, notFoundPage, scopeHeader, signInFirst } from "../chrome.ts";
import { field as formValue, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { localScope } from "../scope.ts";
import {
  badge,
  btn,
  card,
  empty,
  field,
  icon,
  listCard,
  selectField,
  sha,
  time,
} from "../ui.ts";
import { BRANCH_NOT_CREATED, BRANCH_NOT_DELETED } from "../../actions/branch_words.ts";
import { frozenBlock } from "./frozen.ts";
import { refSetFrom } from "./refs.ts";

/**
 * How many rows pay for a `git log -1`. `listBranches` already spends one
 * `rev-list` per branch; this is the same order of cost and the same kind of
 * cap, so a repository with a thousand branches still renders one page.
 */
const TIP_COMMITS = 40;
const TIP_CONCURRENCY = 8;

export interface BranchRow {
  readonly name: string;
  readonly oid: string;
  readonly isDefault: boolean;
  readonly protected: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly tip: Commit | undefined;
}

/** The tip commit of the first `TIP_COMMITS` rows, a few at a time. */
async function withTips(
  dir: string,
  rows: readonly Omit<BranchRow, "tip">[],
): Promise<BranchRow[]> {
  const out: BranchRow[] = rows.map((r) => ({ ...r, tip: undefined }));
  const wanted = out.slice(0, TIP_COMMITS);
  for (let i = 0; i < wanted.length; i += TIP_CONCURRENCY) {
    const slice = wanted.slice(i, i + TIP_CONCURRENCY);
    const logs = await Promise.all(
      slice.map((row) => commitLog(dir, row.oid, { limit: 1 })),
    );
    slice.forEach((row, j) => {
      const log = logs[j];
      const at = out.indexOf(row);
      if (log?.ok === true && log.value[0] !== undefined && at !== -1)
        out[at] = { ...row, tip: log.value[0] };
    });
  }
  return out;
}

/** Every branch this scope can see, however it has to ask. */
async function branchRows(
  ctx: Ctx,
  scope: RepoScope,
): Promise<{ rows: BranchRow[]; compared: boolean }> {
  const repo = scope.repo;
  if (repo === undefined) {
    const listed = await scope.source.branches();
    const rows = (listed.ok ? listed.value : []).map((b) => ({
      name: b.name,
      oid: b.oid,
      isDefault: b.isDefault,
      protected: b.protected === true,
      ahead: null,
      behind: null,
      tip: undefined,
    }));
    rows.sort((a, b) =>
      a.isDefault === b.isDefault
        ? a.name.localeCompare(b.name)
        : a.isDefault
          ? -1
          : 1,
    );
    return { rows, compared: false };
  }
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const listed = await listBranches(dir, repo.defaultBranch);
  if (!listed.ok) return { rows: [], compared: false };
  const bare = listed.value.branches.map((b: BranchInfo) => ({
    name: b.name,
    oid: b.oid,
    isDefault: b.isDefault,
    protected: b.isDefault && repo.protectDefault,
    ahead: b.ahead,
    behind: b.behind,
  }));
  return {
    rows: await withTips(dir, bare),
    compared: listed.value.compared,
  };
}

function divergence(row: BranchRow): Html {
  if (row.isDefault || (row.ahead === null && row.behind === null))
    return html``;
  return html`<span
    class="branch-div num"
    title="commits relative to the default branch"
    >${when(
      (row.ahead ?? 0) > 0,
      () => html`<span class="ahead">↑${row.ahead}</span>`,
    )}${when(
      (row.behind ?? 0) > 0,
      () => html`<span class="behind">↓${row.behind}</span>`,
    )}${(row.ahead ?? 0) === 0 && (row.behind ?? 0) === 0
      ? html`<span class="muted">in sync</span>`
      : null}</span
  >`;
}

function branchRow(
  scope: RepoScope,
  repo: Repo | undefined,
  row: BranchRow,
): Html {
  const base = scope.base;
  const encoded = encodeURIComponent(row.name);
  const canWrite = scope.caps.write && repo !== undefined;
  return html`<li>
    <div class="row branch-row" data-nav tabindex="-1">
      <span class="row-lead">${icon("branch")}</span>
      <span class="row-main">
        <span class="row-title"
          ><a class="mono" href="${base}/tree/${encoded}">${row.name}</a>
          ${when(row.isDefault, () => badge("Default", { variant: "outline" }))}
          ${when(row.protected, () =>
            badge("Protected", { icon: "shield", variant: "secondary" }),
          )}</span
        >
        <span class="row-meta"
          >${sha(row.oid, `${base}/commit/${row.oid}`)}
          ${when(
            row.tip,
            (tip) =>
              html`· ${tip.subject} · updated ${time(tip.date)} by ${tip.author}`,
          )}</span
        >
      </span>
      <span class="row-trail">
        ${divergence(row)}
        ${when(!row.isDefault && canWrite, () =>
          btn("New pull", {
            href: `${base}/pulls/new?head=${encoded}`,
            size: "sm",
            variant: "outline",
            icon: "pull",
          }),
        )}
        ${when(!row.isDefault && canWrite, () =>
          btn("Delete", {
            href: `/-/confirm?to=${encodeURIComponent(
              `${base}/branches/${encodeURIComponent(row.name)}/delete`,
            )}`,
            size: "sm",
            variant: "danger",
            label: `Delete branch ${row.name}`,
          }),
        )}
      </span>
    </div>
  </li>`;
}

function createForm(scope: RepoScope, refs: string[], from: string): Html {
  return card(
    html`<form method="post" action="${scope.base}/branches" class="field-row">
      ${field({
        label: "New branch",
        name: "name",
        placeholder: "feature/thing",
        mono: true,
        required: true,
        autocomplete: "off",
      })}
      ${selectField({
        label: "From",
        name: "from",
        options: refs.map((r) => ({
          value: r,
          label: r,
          selected: r === from,
        })),
      })}
      ${btn("Create branch", { variant: "primary", icon: "plus" })}
    </form>`,
    {
      head: html`${icon("branch")}
        <h2>Create a branch</h2>`,
    },
  );
}

// GET /:owner/:name/branches
export async function branchesPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  // A frozen mirror's branches are where it froze; the page says so first.
  return renderBranches(
    ctx,
    localScope(ctx, repo),
    frozenBlock(ctx, repo) ?? undefined,
  );
}

/** The page itself, for either side of the world. */
export async function renderBranches(
  ctx: Ctx,
  scope: RepoScope,
  banner?: Html,
): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const [{ rows, compared }, refs] = await Promise.all([
    timePhaseAsync(ctx.request, "branches", () => branchRows(ctx, scope)),
    timePhaseAsync(ctx.request, "refs", () => refSetFrom(scope.source)),
  ]);
  const rendering = performance.now();
  const from = ctx.url.searchParams.get("from") ?? scope.facts.defaultBranch;
  const all = [...refs.branches, ...refs.tags];
  const startFrom = all.includes(from) ? from : scope.facts.defaultBranch;

  const body = html`${scopeHeader(ctx, scope, "branches", {
      compact: true,
      branchCount: rows.length,
    })}
    ${banner ?? null}
    <div class="mt">
      ${when(scope.caps.write && scope.repo !== undefined, () =>
        createForm(scope, all.length === 0 ? [startFrom] : all, startFrom),
      )}
      ${rows.length === 0
        ? empty({
            icon: "branch",
            title: "No branches yet",
            note: "Push one, or create the first from the form above.",
          })
        : listCard(
            rows.map((row) => branchRow(scope, scope.repo, row)),
            {
              head: html`<h2>
                  ${rows.length} branch${rows.length === 1 ? "" : "es"}
                </h2>
                ${when(
                  !compared && scope.kind === "local",
                  () =>
                    html`<span class="spacer"></span
                      ><span class="muted small"
                        >Too many branches to compare — ahead/behind is
                        omitted.</span
                      >`,
                )}`,
            },
          )}
    </div>
    ${when(scope.kind === "local", () => liveMount({ repo: scope.base }))}`;

  const response = page({
    ctx,
    title: `Branches · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
    ...(scope.kind === "local" ? { scriptJs: liveClientJs } : {}),
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

export const CREATE_ERRORS: Record<string, string> = {
  invalid_name: "That is not a branch name git will take.",
  invalid_start: "That start point is not one git will take.",
  unknown_start: "That start point does not exist here.",
  exists: "A branch by that name already exists.",
  git_failed: "Git refused to create that branch.",
  origin_owner_only:
    "This repository mirrors an origin, and only the account that connected it may push a branch upstream.",
  origin_unreachable:
    "The origin could not be reached, so nothing was created.",
  origin_refused:
    "The origin refused that branch, so nothing was created here.",
  forbidden: "You need write access to create a branch.",
  unauthorized: "You need write access to create a branch.",
  not_found: "You need write access to create a branch.",
};

// POST /:owner/:name/branches
export async function branchCreate(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const base = `/${repo.ownerName}/${repo.name}/branches`;
  const name = formValue(form, "name");
  const from = formValue(form, "from");
  const created = await createBranch(ctx.app, ctx.auth.user, repo, {
    name,
    ...(from === "" ? {} : { from }),
  });
  if (!created.ok) {
    return flashTo(ctx, base, {
      tone: "danger",
      message: CREATE_ERRORS[created.error] ?? BRANCH_NOT_CREATED,
    });
  }
  return flashTo(ctx, base, {
    message: `Created ${created.value.name} at ${created.value.oid.slice(0, 7)}.`,
  });
}

export const DELETE_ERRORS: Record<string, string> = {
  ...CREATE_ERRORS,
  default_branch:
    "The default branch cannot be deleted — it is what HEAD points at and what every clone lands on.",
  unknown_branch: "That branch no longer exists.",
  branch_moved:
    "That branch moved while the page was open, so nothing was deleted. Reload and look again.",
};

// POST /:owner/:name/branches/:branch/delete
export async function branchDelete(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const base = `/${repo.ownerName}/${repo.name}/branches`;
  const name = ctx.params.branch ?? "";
  const deleted = await deleteBranch(ctx.app, ctx.auth.user, repo, name);
  if (!deleted.ok) {
    return flashTo(ctx, base, {
      tone: "danger",
      message: DELETE_ERRORS[deleted.error] ?? BRANCH_NOT_DELETED,
    });
  }
  return flashTo(ctx, base, { message: `Deleted ${deleted.value.name}.` });
}
