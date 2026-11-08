/**
 * One pull's Files step, and every verb a pull posts to. The change itself
 * — its words, its decision, its conversation — is the studio's change page
 * (`src/web/studio/change.ts`); this is the tab under it: the merge box, the
 * commits it carries, and the diff with inline review. The merge box is an
 * explicit state machine — one card variant per state, each saying what is
 * true and what you can do about it — and the diff is given the full width
 * it needs.
 */

import { pullRoster } from "../studio/pull_roster.ts";
import { originCheckLead, originCheckOf } from "../../origins/pull-check.ts";
import { askCheck } from "../../checks/again.ts";
import { addCommentThrough } from "../../actions/issues.ts";
import { COMMENT_EMPTY, COMMENT_NOT_POSTED } from "../../actions/comment_words.ts";
import type { AccessError } from "../../actions/access.ts";
import { NO_WRITE_ACCESS, PULL_GONE } from "../../actions/pull_words.ts";
import {
  addReview,
  mergePull,
  pullThreads,
  resolveReviewThread,
  submitReview,
  approveToRun,
} from "../../actions/pulls.ts";
import { CHECK_ASKED } from "../../actions/pull_ask_words.ts";
import { reviewWords } from "../../actions/review_words.ts";
import { readFileAt } from "../../apps/checkout.ts";
import { parseCheck } from "../../apps/manifest.ts";
import { RED_ALONE_WAIT, redAloneAt, redMark, type RedMark } from "../../checks/queue.ts";
import { tierLine, type TierState } from "../../checks/tiers.ts";
import { fromKeptFork } from "../../core/landing_kind.ts";
import { combinedCard } from "./pull-combined.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { labelsFor, listLabels } from "../../core/issues.ts";
import { marksByName } from "../../core/marks.ts";
import {
  diffBetween,
  pullDir,
  pullStatus,
  type MergePullError,
  type Pull,
  type PullReviewStatus,
  type PullStatus,
} from "../../core/pulls.ts";
import { isProposed, pullMayRun } from "../../core/pull_trust.ts";
import { checkWords } from "../../checks/summary.ts";
import { runningProgress } from "../../checks/progress.ts";
import { checkStale, checksHold } from "../../checks/stale.ts";
import { checkSummary, type CheckSummary } from "../../core/runs.ts";
import {
  anchorKey,
  byAnchor,
  isReviewState,
  latestReviewByAuthor,
  listReviewComments,
  type ReviewState,
  type Side,
} from "../../core/reviews.ts";
import { getUsersByIds } from "../../core/users.ts";
import { canAdmin, canWrite, getRepoById, type Repo } from "../../core/repos.ts";
import { bypassOffered, landPastGate, type BypassError } from "../../checks/bypass.ts";
import { commitLog, readerFor } from "../../git/read.ts";
import { wallOf } from "../../contract/policy.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
  forbiddenPage,
} from "../chrome.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { DiffLaps } from "../../git/diff.ts";
import { diffCacheCounts, diffKey, keptDiff, keptRender } from "../diff-cache.ts";
import { keptRead } from "../head-reads.ts";
import { landedSlices, sliceEnds, type LandedSlice } from "../../git/slices.ts";
import { landSlice } from "../../actions/pull_slices.ts";
import { diffSyntax } from "../diff-syntax.ts";
import {
  renderDiff,
  type DiffViewOptions,
  type ThreadView,
} from "../diff-view.ts";
import { field, readForm } from "../form.ts";
import { teamVerdicts, type TeamVerdict } from "../../core/issue_teams.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, fragment, page } from "../layout.ts";
import { liveRegionsJs } from "../client.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  badge,
  btn,
  card,
  dot,
  field as formField,
  icon,
  hintAttr,
  labelCss,
  queuedPhrase,
  row,
  selectField,
  sha,
  time,
  type Tone,
} from "../ui.ts";
import {
  assigneeCard,
  labelsCard,
  originError,
  threadFragment,
} from "./thread.ts";
import { previewEnv } from "../../apps/data.ts";
import { specFindings } from "./pull-spec.ts";
import { pullPreviewFindings } from "../../core/preview_findings.ts";
import { crewActivityCard } from "./runs.ts";
import { holdCard } from "../studio/hold.ts";
import { guestWalls, strangerCard } from "./pull-guest.ts";
import { guardedRefusal } from "../../crew/stranger.ts";
import {
  changeHead,
  changeTabs,
  pullContext,
  wallCard,
} from "../studio/change.ts";

/** Parse a "path~side~line" review anchor from a link or form field. */
function parseAnchor(
  raw: string | null,
): { path: string; side: Side; line: number } | undefined {
  if (!raw) return undefined;
  const at = raw.lastIndexOf("~");
  const at2 = raw.lastIndexOf("~", at - 1);
  if (at === -1 || at2 === -1) return undefined;
  const path = raw.slice(0, at2);
  const side = raw.slice(at2 + 1, at);
  const line = Number(raw.slice(at + 1));
  if ((side !== "old" && side !== "new") || !Number.isInteger(line) || line < 1)
    return undefined;
  return { path, side, line };
}

// ---- where the review stands ----

/** A reviewer's current verdict, keyed the way `latestReviewByAuthor` keys it. */
interface Standing {
  readonly who: string;
  readonly state: ReviewState;
  readonly stale: boolean;
}

/**
 * Where each reviewer stands right now, in the order they last spoke.
 *
 * `reviewSummary` counts this; the merge box has to *name* it — "changes
 * requested by bob" is a person to go and talk to, and "1 change requested"
 * is a number to stare at.
 */
function standings(
  db: Ctx["app"]["db"],
  pull: Pull,
  headOid: string,
): Standing[] {
  return [...latestReviewByAuthor(db, pull.id).values()].map((review) => ({
    who: review.originAuthor ?? review.authorName,
    state: review.state,
    stale: review.commitOid !== headOid,
  }));
}

/**
 * The reviews chip: the state of play in one line.
 *
 * Rendered whenever anybody has reviewed or the repository demands one —
 * otherwise the merge box stays the four-line card it was, because a repo
 * with no review policy should not grow review furniture.
 */
function reviewsChip(
  reviews: PullReviewStatus | null,
  by: readonly Standing[],
): Html {
  if (reviews === null) return html``;
  const blocking = by.filter(
    (s) => !s.stale && s.state === "changes_requested",
  );
  const parts: Html[] = [];
  if (reviews.approved > 0)
    parts.push(
      html`<span class="ok"
        >${icon("check")}${reviews.approved}
        approval${reviews.approved === 1 ? "" : "s"}</span
      >`,
    );
  if (blocking.length > 0)
    parts.push(
      html`<span class="bad"
        >${icon("alert")}changes requested by
        ${blocking.map((s) => s.who).join(", ")}</span
      >`,
    );
  if (parts.length === 0) {
    if (!reviews.required) return html``;
    parts.push(html`<span class="muted">No reviews yet</span>`);
  }
  return html`<p class="reviews-chip">
    ${parts.map((part, i) =>
      i === 0
        ? part
        : html`<span class="sep" aria-hidden="true">·</span>${part}`,
    )}${when(
      reviews.required,
      () =>
        html`<span class="sep" aria-hidden="true">·</span
          ><span class="muted">an approval is required</span>`,
    )}
  </p>`;
}

// ---- the checks ----

/** What a reader's unapproved head shows where its checks would be. */
const WAITING_WORDS =
  "Checks and the preview wait for a writer to approve this head";

/**
 * The checks line: where the deploy of this head stands (docs/APPS.md, rule
 * 4). Rendered whenever the repository runs as an app or requires checks —
 * a repository with neither has no checks, and should not grow furniture
 * for them. A run is named so the reader can go and look at its log.
 */
export function checksLine(
  base: string,
  check: CheckSummary,
  required: boolean,
  isApp: boolean,
  /** The head is a reader's and no writer has approved it yet. */
  waiting = false,
  /** `tierLine` for a repository whose check has a fast tier; else empty. */
  tier = "",
  /** A writer's button to ask for a check again; empty for anyone else. */
  again: Html | "" = "",
  /** Files the pull conflicts in; a passing check is not a green mark then. */
  conflicts = 0,
  /** The pull's base branch, to name what the check was merged with. */
  baseBranch = "",
  /** The green was checked against a base that has since moved. */
  stale = false,
  /** `progressWords` of a running check's log; empty when none is known. */
  progress = "",
  /** Where this line answers for itself (`data-live-src`); empty for none. */
  liveSrc = "",
): Html {
  if (!isApp && !required && check.state === "none" && !waiting && again === "")
    return html``;
  const run = check.run;
  const link =
    run === null
      ? null
      : html`<span class="sep" aria-hidden="true">·</span
          ><a href="${base}/runs/${run.id}"
            >${run.kind === "check" ? "Check of" : "deploy"} ${run.commitOid.slice(0, 7)}</a
          >`;
  const words = run === null ? undefined : checkWords(run, Date.now(), progress);
  const against =
    run !== null && run.baseOid !== "" && baseBranch !== ""
      ? html`<span class="sep" aria-hidden="true">·</span
          ><span class="checked-against"
            >checked against ${baseBranch} at ${run.baseOid.slice(0, 7)}</span
          >`
      : html``;
  const body =
    check.state === "ok" && conflicts > 0
      ? html`<span class="bad"
          >${icon("x")}Conflicts in ${conflicts} ${conflicts === 1 ? "file" : "files"}</span
        >${link}`
    : check.state === "ok" && stale
      ? html`<span class="now"
          >${icon("clock")}Checked against an older ${baseBranch || "base"}</span
        >${link}`
    : check.state === "ok"
      ? html`<span class="ok">${icon("check")}${words ?? "Check passed"}</span>${link}`
      : check.state === "failed"
        ? html`<span class="bad">${icon("x")}${words ?? "Check failed"}</span>${link}`
        : check.state === "queued"
          ? html`<span class="now"
              >${icon("loader")}Check
              ${run ? queuedPhrase(run.createdAt) : "queued"}</span
            >${link}`
          : check.state === "running"
            ? html`<span class="now">${icon("loader")}${words ?? "Check running"}</span
                >${link}`
            : check.state === "cancelled"
              ? html`<span>${icon("ban")}Check cancelled</span>${link}`
              : waiting
                ? html`<span>${icon("lock")}${WAITING_WORDS}</span>`
                : html`<span>${icon("clock")}No checks on this head yet</span>`;
  // Its own address: an event fetches this line, not the page. A finished
  // shard is a `run.shard` event (`checks/shard_event.ts`), so no beat.
  const live =
    liveSrc === ""
      ? null
      : html`id="live-checks" data-live="run.*" data-live-src="${liveSrc}"`;
  return html`<p class="checks-line" ${live}>
    ${body}${against}${when(
      tier !== "",
      () =>
        html`<span class="sep" aria-hidden="true">·</span
          ><span class="tier-line">${tier}</span>`,
    )}${when(
      required,
      () =>
        html`<span class="sep" aria-hidden="true">·</span
          ><span>a passing deploy is required</span>`,
    )}${again}
  </p>`;
}

/** One muted line when the merge queue holds the pull as red alone; nothing otherwise. */
export function redAloneLine(mark: RedMark | undefined): Html {
  if (mark === undefined) return html``;
  const exact = redAloneAt(mark);
  if (exact === "") return html``;
  return html`<p class="muted small">
    ${icon("clock")}red alone at
    <time datetime="${new Date(mark.at).toISOString()}">${exact}</time>, ${RED_ALONE_WAIT}
  </p>`;
}

/** Whether a head declares a fast tier: a commit's files never change. */
const fastByHead = new Map<string, boolean>();
export async function declaresFast(dir: string, head: string): Promise<boolean> {
  const known = fastByHead.get(head);
  if (known !== undefined) return known;
  const [forgeJson, packageJson] = await Promise.all([
    readFileAt(dir, head, "forge.json"),
    readFileAt(dir, head, "package.json"),
  ]);
  const declared = parseCheck(forgeJson, packageJson);
  const fast = declared.ok && declared.value?.fast != null;
  // Nothing read: remember that only for a commit known to exist (its tree
  // reads); an unreadable one may simply not have landed yet.
  if (forgeJson === undefined && packageJson === undefined) {
    const tree = await readerFor(dir).object(`${head}^{tree}`);
    if (!tree.ok) return fast;
  }
  if (fastByHead.size >= 500) fastByHead.delete(fastByHead.keys().next().value!);
  fastByHead.set(head, fast);
  return fast;
}

/**
 * The tiers' words for a pull whose check declares a fast tier (#1198);
 * nothing when it does not, or when no check has run on this head.
 */
async function tierOf(
  dir: string,
  head: string,
  check: CheckSummary,
): Promise<string> {
  const run = check.run;
  if (run === null || run.kind !== "check") return "";
  if (!(await declaresFast(dir, head))) return "";
  const state: TierState | undefined =
    check.state === "ok"
      ? "green"
      : check.state === "failed"
        ? "red"
        : check.state === "queued" || check.state === "running"
          ? check.state
          : undefined;
  if (state === undefined) return "";
  const took =
    run.startedAt !== null && run.finishedAt !== null
      ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
      : undefined;
  return tierLine(state, took);
}

// ---- the merge box ----

/**
 * The checks line of a pull, as the merge box shows it and as its live
 * address answers it: one function, so the two never disagree. A running
 * check's counts come from its own log, read here and nowhere else.
 */
function pullChecksLine(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  status: PullStatus,
  check: CheckSummary,
  isApp: boolean,
  tier = "",
  stale = false,
): Html {
  const thread = `${repoBase(repo)}/pulls/${pull.number}`;
  const progress = runningProgress(ctx.app.config.dataDir, check);
  const line = checksLine(
    repoBase(repo),
    check,
    repo.requireChecks,
    isApp,
    !pullMayRun(ctx.app.db, repo, pull, status.headOid),
    tier,
    pull.state === "open" && canWrite(ctx.app.db, repo, ctx.auth.user)
      ? html`<form method="post" action="${thread}/checks" class="inline-form">
          ${btn("Check again", { size: "sm", icon: "play" })}
        </form>`
      : "",
    status.conflicts.length,
    pull.baseBranch,
    stale,
    progress,
    `${thread}/checks-line`,
  );
  const found = !isApp ? null : pullPreviewFindings(ctx.app.db, repo.id, previewEnv(pull.number));
  const red = redAloneLine(redMark(repo.id, pull.id, status.headOid));
  return html`${originCheckLine(ctx, repo, pull)}${line}${red}${found === null ? "" : specFindings(found)}`;
}

/**
 * How the origin's own check stands on a mirrored pull, as it last said and
 * when. Empty for a pull the origin has never reported on.
 */
function originCheckLine(ctx: Ctx, repo: Repo, pull: Pull): Html | "" {
  if (repo.origin === null) return "";
  const kept = originCheckOf(ctx.app.db, pull.id);
  if (kept === undefined) return "";
  return html`<p class="muted">${originCheckLead(repo.origin.fullName, kept, pull.headOid)}, as of ${time(kept.checkedAt)}</p>`;
}

/**
 * One §5 row on a bare card; `.setting-list` wraps the sentence and drops the
 * action under it on a phone. A bare card draws no tone, so the state is the
 * sentence's opening word ("Merged.", "Ready to merge", "Waiting on checks.")
 * with the tone's dot beside it: a word, not colour alone (principle 6).
 */
function box(
  tone: Tone | undefined,
  lead: Html,
  /** A fixed phrase of ours, never a person's text. */
  title: Html | string,
  meta: Html,
  trail: Html | null,
): Html {
  const said = typeof title === "string" ? raw(title) : title;
  return card(
    html`<ul class="list setting-list">
      ${row({
        lead,
        title: html`${dot(tone)} ${said}`,
        meta,
        ...(trail ? { trail } : {}),
      })}
    </ul>`,
    { pad: false, extra: "mt bare" },
  );
}

/**
 * Six states, six cards. Every one names the situation, gives the reason,
 * and offers exactly the actions that are actually available.
 */
function mergeBox(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  status: PullStatus,
  mayMerge: boolean,
  by: readonly Standing[],
  check: CheckSummary,
  isApp: boolean,
  tier = "",
  stale = false,
): Html {
  const thread = `${repoBase(repo)}/pulls/${pull.number}`;
  // A reader's head runs nothing until a writer approves it; say so rather
  // than leave "no checks yet" waiting for something that will not come.
  const checks = pullChecksLine(ctx, repo, pull, status, check, isApp, tier, stale);
  const reopen = html`<form method="post" action="${thread}/state" data-now="Reopened" data-now-once>
    <input type="hidden" name="state" value="open" />
    ${btn("Reopen", { size: "sm", icon: "pull" })}
  </form>`;

  if (pull.mergedAt !== null) {
    return box(
      "merged",
      icon("merge"),
      "Merged.",
      html`<span class="mono">${pull.headBranch}</span> was merged into
        <span class="mono">${pull.baseBranch}</span>${when(
          pull.mergedOid,
          (oid) => html` as ${sha(oid, `${repoBase(repo)}/commit/${oid}`)}`,
        )}.`,
      null,
    );
  }

  if (pull.state === "closed") {
    return box(
      undefined,
      icon("x"),
      "Closed without merging.",
      html`Nothing was applied to <span class="mono">${pull.baseBranch}</span>.`,
      // Reopening is its author's or a writer's (`setIssueState`), as in the palette.
      when(ctx.auth.user !== undefined && (ctx.auth.user.id === pull.authorId || mayMerge), () => reopen),
    );
  }

  // A mirror's merge belongs to the origin: merging locally would rewrite the
  // base branch here and be overwritten by the next fetch, and merging through
  // the API would have to reproduce the origin's strategy, protections and
  // required checks exactly. So the box says where the button is instead.
  if (repo.origin !== null || pull.originHeadRepo !== null) {
    const at = repo.origin;
    return box(
      "attn",
      icon(at?.kind ?? "globe"),
      "Merge on the origin.",
      html`This repository mirrors
        ${at === null || at.fullName === ""
          ? html`another forge`
          : html`<span class="mono">${at.fullName}</span>`},
        which is truth for it. Merge there and the next sync brings back the
        merge commit it actually made.`,
      when(pull.originUrl, (url) =>
        btn("Open on the origin", {
          href: url,
          variant: "primary",
          icon: "external",
        }),
      ),
    );
  }

  if (!status.mergeable) {
    const reason =
      status.ahead === 0
        ? html`Base already contains these commits — there is nothing left to
          apply.`
        : status.conflicts.length > 0
          ? html`Conflicts in ${status.conflicts.length}
              file${status.conflicts.length === 1 ? "" : "s"}:
              <span class="mono"
                >${status.conflicts.slice(0, 3).join(", ")}</span
              >${status.conflicts.length > 3 ? "…" : ""}. Merge
              <span class="mono">${pull.baseBranch}</span> into the branch and
              push again.${mayMerge
                ? html` <a href="${thread}/resolve">Resolve</a> it here.`
                : ""}`
          : html`This branch cannot be applied automatically.`;
    return box(
      "danger",
      icon("alert"),
      "Can't merge.",
      html`${reason} ${reviewsChip(status.reviews, by)} ${checks}`,
      null,
    );
  }

  // Git says yes; the review gate may still say no. It is the same question
  // `mergePull` asks at the moment it lands (`review_required`) — asked here
  // so the button is honest, not so the check happens here.
  const gated = status.reviews !== null && !status.reviews.mergeable;
  if (gated) {
    const blocking = by.filter(
      (s) => !s.stale && s.state === "changes_requested",
    );
    const why =
      blocking.length > 0
        ? html`${blocking.map((s) => s.who).join(", ")} asked for changes. Push
          a fix, and ask for another look.`
        : html`This repository requires an approving review of the commit that
          is head right now. A verdict passed before the latest push does not
          count.`;
    return box(
      "attn",
      icon("eye"),
      "Waiting on review.",
      html`${why} ${reviewsChip(status.reviews, by)} ${checks}`,
      when(mayMerge, () =>
        btn("Merge pull request", {
          variant: "primary",
          icon: "merge",
          disabled: true,
          title: "An approving review of this head is required first",
        }),
      ),
    );
  }

  // The check gate, `mergePull`'s `checks_required`: the deploy of the
  // commit that is head right now must have passed. Read live here so the
  // button is honest — the refusal itself happens in the merge.
  if (checksHold(repo.requireChecks, check.state, stale)) {
    const why =
      check.state === "ok"
        ? html`This head was checked against an older
            <span class="mono">${pull.baseBranch}</span>. Use Check again to judge
            it on the current base; the merge unlocks when that passes.`
        : check.state === "failed"
        ? html`The deploy of this head failed. Push a fix — a passing deploy is
          required before merging.`
        : check.state === "running" || check.state === "queued"
          ? html`This head is still deploying. The merge unlocks when the check
            passes.`
          : check.state === "cancelled"
            ? html`The deploy of this head was cancelled. Redeploy the preview,
              or push again.`
            : html`There is no deploy of this head yet. Nothing merges until one
              passes.`;
    return box(
      "attn",
      icon("loader"),
      "Waiting on checks.",
      html`${why} ${reviewsChip(status.reviews, by)} ${checks}`,
      when(mayMerge, () =>
        html`${btn("Merge pull request", {
          variant: "primary",
          icon: "merge",
          disabled: true,
          title: "A passing deploy of this head is required first",
        })}${when(
          bypassOffered(ctx.app, ctx.auth.user, repo),
          () => html`<form method="post" action="${thread}/land-past">
            ${formField({
              name: "reason",
              label: "Land past the gate",
              hint: "Landing has stopped. Say why this pull lands without its checks; it goes on the pull's trail. Review and conflicts still count.",
              required: true,
              minlength: 8,
              maxlength: 500,
            })}
            <div class="form-actions">${btn("Land past the gate", { variant: "danger", icon: "merge" })}</div>
          </form>`,
        )}`,
      ),
    );
  }

  return box(
    "success",
    icon("check"),
    html`Ready to merge — no conflicts with
      <span class="mono">${pull.baseBranch}</span>.`,
    html`${status.ahead} commit${status.ahead === 1 ? "" : "s"} will land on
      <span class="mono">${pull.baseBranch}</span>. ${reviewsChip(status.reviews, by)}
      ${checks}`,
    mayMerge
      ? html`<form method="post" action="${thread}/merge" class="row-fields">
          ${fromKeptFork(ctx.app.db, pull)
            ? html`<input type="hidden" name="strategy" value="merge" />
                <span class="muted small">Lands as a merge commit: a kept fork's commits keep their authors.</span>`
            : html`<label class="sr-only" for="strategy">Merge strategy</label>
                <select class="input" id="strategy" name="strategy">
                  <option value="merge">Merge commit</option>
                  <option value="squash">Squash and merge</option>
                </select>`}
          ${btn("Merge pull request", {
            variant: "primary",
            icon: "merge",
          })}
        </form>`
      : html`<span class="muted small">You need write access to merge.</span>`,
  );
}

// ---- threads ----

/**
 * Every thread's settled-ness, keyed the way the diff viewer looks it up.
 *
 * Who may settle one is the same rule `resolveReviewThread` enforces: a
 * writer, or anybody who commented in the thread — the reviewer who raised a
 * point is exactly the person who can say it is answered. Resolvers are
 * named in one grouped read rather than one per thread.
 */
function threadStateViews(
  ctx: Ctx,
  repo: Repo,
  threads: ReturnType<typeof pullThreads>,
): Map<string, ThreadView> {
  const user = ctx.auth.user;
  const writer = canWrite(ctx.app.db, repo, user);
  const resolvers = getUsersByIds(
    ctx.app.db,
    threads.map((t) => t.resolvedBy ?? "").filter(Boolean),
  );
  const views = new Map<string, ThreadView>();
  for (const t of threads) {
    const mine =
      user !== undefined &&
      t.comments.some((c) => c.authorName === user.username);
    views.set(anchorKey(t.path, t.side, t.line), {
      anchor: t.anchor,
      resolvedAt: t.resolvedAt,
      resolvedBy:
        t.resolvedBy === null
          ? null
          : (resolvers.get(t.resolvedBy)?.username ?? null),
      mayResolve: user !== undefined && (writer || mine),
    });
  }
  return views;
}

const VERDICT_WORDS: Record<string, string> = {
  approved: "approved",
  changes_requested: "asked for changes",
  commented: "commented",
};

/** One line per team the closed issue names: whose verdict it is, or that it is awaited (#2681). */
export function teamsCard(verdicts: readonly TeamVerdict[]): Html {
  if (verdicts.length === 0) return html``;
  return html`<section class="team-verdicts mt" aria-label="Team reviews">
    <ul class="list">
      ${verdicts.map(
        (v) => html`<li class="row"><span>
          <strong>${v.name}</strong>:
          ${v.state === undefined
            ? html`<span class="muted">awaiting a reviewer</span>`
            : html`${VERDICT_WORDS[v.state] ?? v.state} by ${v.by ?? ""}${v.stale
                ? html` <span class="muted">(on an older head)</span>`
                : ""}`}
        </span></li>`,
      )}
    </ul>
  </section>`;
}

/**
 * The review card: pass a verdict.
 *
 * One form, three radios and a box. Which radios appear is the rule made
 * visible — a reader may only comment, because an approval that anyone who
 * can see the repository could give would make "require review" decorative;
 * and the author never sees Approve, because you cannot approve your own
 * change. Both are refused in `submitReview` too, which is where they are
 * actually enforced.
 *
 * Each verdict carries a `v` chord (`v a`, `v r`, `v c`) that picks the
 * radio and leaves the caret in the box — a prefix nobody hits by accident,
 * and only what a click would do. Submitting stays the button's, or
 * Cmd/Ctrl+Enter from the box (`data-submit-key`), never a bare key.
 */
function reviewCard(ctx: Ctx, repo: Repo, pull: Pull, action: string): Html {
  const user = ctx.auth.user;
  if (user === undefined)
    return card(html`<a href="/signin">Sign in</a> to review this change.`, {
      extra: "mt bare",
      head: html`${icon("eye")}
        <h2>Review</h2>`,
    });
  if (pull.mergedAt !== null || pull.state === "closed") return html``;
  const writer = canWrite(ctx.app.db, repo, user);
  const isAuthor = pull.authorId === user.id;
  const options: { value: string; label: string; hint: string; key: string }[] =
    [];
  // A reader's change runs nothing here until a writer approves it: the
  // approval is also what lets its code run, and the reviewer should know.
  const runsOnApproval = !pullMayRun(ctx.app.db, repo, pull, "");
  if (writer && !isAuthor)
    options.push({
      value: "approved",
      label: "Approve",
      hint: runsOnApproval
        ? "This is good to merge — and its check and preview then run this code here, holding the repository owner's app token."
        : "This is good to merge.",
      key: "v a",
    });
  if (writer)
    options.push({
      value: "changes_requested",
      label: "Request changes",
      hint: "Blocks the merge until it is withdrawn.",
      key: "v r",
    });
  options.push({
    value: "commented",
    label: "Comment",
    hint: "A note on the change as a whole, with no verdict.",
    key: "v c",
  });

  return card(
    html`<form method="post" action="${action}" data-submit-key>
      <fieldset class="review-verdicts">
        <legend class="sr-only">Your verdict</legend>
        ${options.map(
          (option, i) =>
            html`<label class="check" ${hintAttr(option.key)}>
              <input
                type="radio"
                name="state"
                value="${option.value}"
                data-shortcut="${option.key}"
                title="${option.label}"
                ${i === options.length - 1 ? raw("checked") : null}
              />
              <span
                >${option.label} <span class="hint">${option.hint}</span></span
              >
            </label>`,
        )}
      </fieldset>
      <label class="sr-only" for="review-body">Review comment</label>
      <textarea
        class="input mt"
        id="review-body"
        name="body"
        rows="3"
        data-grow
        placeholder="Say something about the change as a whole (optional)"
      ></textarea>
      <div class="form-actions">
        ${when(
          isAuthor,
          () =>
            html`<span class="muted small"
              >${icon("alert")} ${reviewWords.selfReview}</span
            >`,
        )}
        ${when(
          !writer,
          () =>
            html`<span class="muted small"
              >${icon("alert")} ${reviewWords.forbidden}</span
            >`,
        )}
        <span class="spacer"></span>
        ${btn("Submit review", { variant: "primary", icon: "check" })}
      </div>
    </form>`,
    {
      extra: "mt review-card bare",
      head: html`${icon("eye")}
        <h2>Review</h2>`,
    },
  );
}

// ---- the Files step ----

/**
 * GET /:owner/:name/pulls/:number/files — the change's Files step: one tab
 * deeper than the change itself, under the same head. Everything a person
 * needs to read the code and land it by hand lives here and nowhere else:
 * where the change lives, the merge box, a verdict, the commits, who has it
 * and its labels, and the diff with its inline review threads. The diff is
 * computed on this tab only, so the change's own page never gets slower as
 * a change gets bigger.
 */
export async function pullFilesPage(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  const began = performance.now();
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const spent = { diff: 0, git: 0, checks: 0, reviews: 0 };
  /** Run `work`, adding the time it took to `spent[key]`. */
  const lap = async <T>(key: keyof typeof spent, work: () => T | Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      spent[key] += performance.now() - started;
    }
  };
  /** The same for a synchronous call: no await, no microtask. */
  const tick = <T>(key: keyof typeof spent, work: () => T): T => {
    const started = performance.now();
    try {
      return work();
    } finally {
      spent[key] += performance.now() - started;
    }
  };
  // Every read of the change is taken where its objects are (`pullDir`).
  const dir = await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);
  const base = repoBase(repo);
  const thread = `${base}/pulls/${pull.number}`;

  // The review gate travels with the status, so the merge box and
  // `mergePull` are answering the same question from the same numbers.
  const status = await lap("git", () =>
    pullStatus(dir, pull, {
      db: ctx.app.db,
      requireReview: repo.requireReview,
    }),
  );
  // The diff and its highlighting depend on two oids and nothing else, so
  // the next reader of this head gets them from memory (`diff-cache.ts`).
  // On a miss the stretches say where the time went; a hit has none.
  const stretches: DiffLaps & { highlight?: number } = {};
  const cacheBefore = diffCacheCounts();
  const { diff, syntax, failed } = await lap("diff", () =>
    keptDiff(diffKey(status.baseOid, status.headOid), async () => {
      const { from, diff, failed } = await diffBetween(dir, status.baseOid, status.headOid, stretches);
      const highlighting = performance.now();
      const syntax = await diffSyntax(dir, diff, from, status.headOid);
      stretches.highlight = performance.now() - highlighting;
      return { from, diff, failed, syntax };
    }),
  );
  const cacheAfter = diffCacheCounts();
  const diffHit = cacheAfter.hits > cacheBefore.hits && cacheAfter.misses === cacheBefore.misses;
  // A merged or closed pull is history; the wall is a question about landing.
  const wall =
    pull.mergedAt === null && pull.state === "open"
      ? await lap("git", () =>
          keptRead(`wall:${status.baseOid}:${status.headOid}`, () => wallOf(dir, status.baseOid, status.headOid)),
        )
      : undefined;
  const reviewLines = tick("reviews", () => listReviewComments(ctx.app.db, pull.id));
  const reviewComments = byAnchor(reviewLines);
  const mayMerge = canWrite(ctx.app.db, repo, ctx.auth.user);
  const applied = labelsFor(ctx.app.db, pull.id);
  const allLabels = listLabels(ctx.app.db, repo.id);
  const by = tick("reviews", () => standings(ctx.app.db, pull, status.headOid));
  // The checks are the deploy runs of the live head, read here for the same
  // reason the review gate is: the box and the merge answer one question.
  const check = tick("checks", () => checkSummary(ctx.app.db, pull.id, status.headOid));
  const isApp = getAppByRepo(ctx.app.db, repo.id) !== undefined;
  const tier = await lap("checks", () => tierOf(dir, status.headOid, check));
  // `status.baseOid` is the live base tip already: no second reading of it.
  const stale =
    pull.state === "open" && pull.mergedAt === null
      ? checkStale(check.run, status.baseOid)
      : false;
  const threads = await lap("reviews", () => pullThreads(ctx.app, pull));
  const threadViews = threadStateViews(ctx, repo, threads);
  const unresolved = threads.filter((t) => t.resolvedAt === null).length;

  // A "?rc=path~side~line" link opens an inline comment form at that row.
  const active = ctx.auth.user
    ? parseAnchor(ctx.url.searchParams.get("rc"))
    : undefined;
  const diffOptions: DiffViewOptions = {
    syntax,
    comments: reviewComments,
    threads: threadViews,
    marks: marksByName(ctx.app.db, [
      ...reviewLines.map((c) => c.authorName),
      ...[...threadViews.values()].map((t) => t.resolvedBy ?? ""),
    ]),
    fileLinkBase: `${base}/blob/${status.headOid}`,
    ...(ctx.auth.user
      ? { reviewBase: thread, reviewPage: `${thread}/files` }
      : {}),
    ...(active ? { active } : {}),
  };

  // Nothing viewer-specific is drawn when no comment, thread or form is; then
  // the markup is a function of the diff and the link bases (`keptRender`).
  const renderKey =
    reviewLines.length === 0 && threadViews.size === 0 && active === undefined && !failed
      ? `${diffKey(status.baseOid, status.headOid)}|${diffOptions.fileLinkBase}|${diffOptions.reviewBase ?? ""}|${diffOptions.reviewPage ?? ""}`
      : undefined;

  const headRepo = pull.crossRepo
    ? getRepoById(ctx.app.db, pull.headRepoId)
    : undefined;
  const headLabel = headRepo
    ? `${headRepo.ownerName}/${headRepo.name}:${pull.headBranch}`
    : pull.headBranch;

  const logLimit = Math.min(Math.max(status.ahead, 1), 100);
  const log = await lap("git", () =>
    keptRead(
      `log:${status.headOid}:${logLimit}`,
      () => commitLog(dir, status.headOid, { limit: logLimit }),
      (r) => r.ok,
    ),
  );
  const commits = log.ok ? log.value : [];
  // A fork's pull may land in slices; which did is read from the base (#9010).
  // A person lands them: the crew proposes (rule 1 in docs/APPS.md).
  const mayLand = mayMerge && ctx.auth.user?.kind !== "agent";
  const slices = pull.crossRepo
    ? await lap("git", () =>
        keptRead(`slices:${repo.id}:${pull.number}:${status.baseOid}`, () =>
          landedSlices(dir, status.baseOid, pull.number, pull.createdAt),
        ),
      )
    : [];
  const ends =
    pull.crossRepo && mayLand && pull.state === "open" && pull.mergedAt === null && status.ahead > 1
      ? await lap("git", () =>
          keptRead(`slice-ends:${repo.id}:${status.baseOid}:${status.headOid}`, () =>
            sliceEnds(dir, status.baseOid, status.headOid),
          ),
        )
      : [];
  const commitsCard = card(
    commits.length === 0
      ? html`<p class="muted small">No commits to show.</p>`
      : html`<ul class="list">
          ${commits.map(
            (commit) =>
              html`<li>
                <a class="row" href="${base}/commit/${commit.oid}">
                  <span class="row-lead">${avatar(commit.author)}</span>
                  <span class="row-main">
                    <span class="row-title" title="${commit.subject}"
                      >${commit.subject}</span
                    >
                    <span class="row-meta"
                      >${commit.author} · ${time(commit.date)}</span
                    >
                  </span>
                  <span class="row-trail">${sha(commit.oid)}</span>
                </a>
              </li>`,
          )}
        </ul>`,
    {
      extra: "bare",
      pad: false,
      head: html`${icon("commit")}
        <h2>${commits.length} commit${commits.length === 1 ? "" : "s"}</h2>`,
    },
  );

  const body = html`${repoHeader(ctx, repo, "pulls", {
      compact: true,
      ownTitle: true,
    })}
    ${changeHead(ctx, repo, pull, { headOid: status.headOid, conflicts: status.conflicts.length })}
    ${changeTabs(repo, pull, "files")}
    <p class="files-where muted small" id="files">
      <span class="mono">${headLabel} → ${pull.baseBranch}</span>
      <span class="sep" aria-hidden="true">·</span>
      ${status.ahead} commit${status.ahead === 1 ? "" : "s"}
      ${when(
        pull.crossRepo,
        () => html`<span class="sep" aria-hidden="true">·</span
          >${badge("fork", { icon: "fork" })}`,
      )}
      ${when(
        threads.length > 0,
        () =>
          html`<span class="sep" aria-hidden="true">·</span
            ><span class="thread-count"
              >${threads.length} thread${threads.length === 1 ? "" : "s"} ·
              ${unresolved} unresolved</span
            >`,
      )}
    </p>
    ${when(wall, (w) => wallCard(w, mayMerge ? thread : undefined))}
    ${holdCard(ctx, repo, pull, { act: false })}
    ${teamsCard(teamVerdicts(ctx.app.db, { ...pull, headOid: status.headOid }))}
    ${mergeBox(ctx, repo, pull, status, mayMerge, by, check, isApp, tier, stale)}
    ${slicesCard(base, thread, slices, status.ahead, ends, pull.state === "open" && pull.mergedAt === null, mayLand)}
    ${await combinedCard(dir, pull, status.headOid, status.baseOid)}
    <div class="split">
      <div>
        ${await strangerCard(ctx, repo, pull, `${thread}/approve-guest`, await guestWalls(ctx, repo, pull, status.baseOid))}
        ${approveHereCard(ctx, repo, pull, status.headOid, `${thread}/approve-here`)}
        ${reviewCard(ctx, repo, pull, `${thread}/review-state`)}
      </div>
      <aside>
        ${assigneeCard(ctx, repo, pull, `${thread}/assignee`)}
        ${labelsCard(ctx, repo, pull, applied, allLabels, `${thread}/labels`)}
        <div class="mt">${commitsCard}</div>
        ${crewActivityCard(ctx, repo, pull)}
      </aside>
    </div>
    <div class="mt">${keptRender(renderKey, () => renderDiff(diff, diffOptions))}</div>
    ${liveMount({ repo: base })}`;

  const response = page({
    ctx,
    title: `Files · ${pull.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: [
      ...repoPalette(ctx, repo),
      ...pullRoster({
        base,
        number: pull.number,
        headBranch: pull.headBranch,
        crossRepo: pull.crossRepo,
        signedIn: ctx.auth.user !== undefined,
        writer: mayMerge,
        state: pull.state === "closed" ? "closed" : "open",
        merged: pull.mergedAt !== null,
        // The merge box's enabled button, by the same gates in the same order.
        labels: allLabels.length > 0,
        mayState: ctx.auth.user !== undefined && (ctx.auth.user.id === pull.authorId || mayMerge),
        mergeReady:
          mayMerge &&
          pull.state === "open" &&
          pull.mergedAt === null &&
          repo.origin === null &&
          pull.originHeadRepo === null &&
          status.mergeable &&
          !(status.reviews !== null && !status.reviews.mergeable) &&
          !checksHold(repo.requireChecks, check.state, stale),
      }),
    ],
    body,
    styleCss: labelCss([...allLabels, ...applied]),
    scriptJs: `${liveClientJs}\n${liveRegionsJs}`,
  });
  const { diff: diffMs, git, checks, reviews } = spent;
  notePhase(ctx.request, "diff", diffMs, diffHit);
  for (const [name, ms] of Object.entries(stretches)) notePhase(ctx.request, `diff-${name}`, ms);
  notePhase(ctx.request, "git", git);
  notePhase(ctx.request, "checks", checks);
  notePhase(ctx.request, "reviews", reviews);
  notePhase(
    ctx.request,
    "render",
    Math.max(0, performance.now() - began - diffMs - git - checks - reviews),
  );
  return response;
}

// GET /:owner/:name/pulls/:number/thread?after=<id>
export function pullThreadFragment(ctx: Ctx): Response {
  return threadFragment(ctx, "pull");
}

// ---- mutations ----

// POST /:owner/:name/pulls/:number/comments
export async function pullCommentSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  // A reply from the feed returns there: a fixed word, never a URL from the form.
  const fromFeed = field(form, "back") === "feed";
  const bodyText = field(form, "body");
  if (bodyText.trim() === "")
    return flashTo(ctx, fromFeed ? "/feed" : dest, {
      tone: "danger",
      message: COMMENT_EMPTY,
    });
  const added = await addCommentThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    bodyText,
  );
  if (!added.ok)
    return flashTo(ctx, fromFeed ? "/feed" : dest, {
      tone: "danger",
      message: originError(added.error) ?? COMMENT_NOT_POSTED,
    });
  return fromFeed
    ? flashTo(ctx, "/feed", { message: "Reply posted." })
    : flashTo(ctx, `${dest}#conversation`, { message: "Comment posted." });
}

/** Match the diff viewer's per-file anchor id, so the redirect lands there. */
function fileHashAnchor(path: string): string {
  return "d-" + path.replace(/[^a-zA-Z0-9]+/g, "-");
}

// POST /:owner/:name/pulls/:number/review — a comment anchored to a diff line.
export async function pullReviewSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  // The form lives on the Files step, so every answer lands back there.
  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}/files`;
  const anchor = parseAnchor(
    `${field(form, "path")}~${field(form, "side")}~${field(form, "line")}`,
  );
  const bodyText = field(form, "body");
  if (!anchor || bodyText.trim() === "") {
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "That review comment had no line or no text.",
    });
  }
  // The line's content hash is computed server-side from the blob the anchor
  // names, so a stale form can never claim a line said something it did not.
  const added = await addReview(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    {
      body: bodyText,
      path: anchor.path,
      line: anchor.line,
      side: anchor.side,
    },
  );
  if (!added.ok) {
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        added.error === "bad_anchor"
          ? "That line is no longer part of this diff."
          : added.error === "empty_body"
            ? "A review comment needs some text."
            : added.error === "body_too_long"
              ? "That review comment is too long (64 KB at most)."
              : "That review comment could not be saved.",
    });
  }
  return flashTo(ctx, `${dest}#${fileHashAnchor(anchor.path)}`, {
    message: "Review comment added.",
  });
}

/**
 * Why a merge did not land, in words. The action's error is either an access
 * or lifecycle code, or git's own structured `MergeError` — both are answers
 * the person pressing the button deserves to see.
 */
export function mergeFailure(error: AccessError | MergePullError): string {
  if (typeof error !== "string") {
    if (error.kind === "conflict")
      return `The branches conflict in ${error.files.length} file${error.files.length === 1 ? "" : "s"} — merge the base branch in and push again.`;
    if (error.kind === "base_moved")
      return "The base branch moved while merging. Try again.";
    if (error.kind === "unsafe") return "That merge was refused as unsafe.";
    if (error.kind === "guarded") return guardedRefusal(error.paths);
    return "Git refused the merge.";
  }
  const fromOrigin = originError(error);
  if (fromOrigin !== undefined) return fromOrigin;
  if (error === "already_merged")
    return "This pull request was already merged.";
  if (error === "closed")
    return "A closed pull request cannot be merged. Reopen it first.";
  if (error === "head_moved")
    return "The pull's head moved while it was being checked. Nothing was merged; look again and retry.";
  // The gate races: the page was rendered with an approval that a push
  // dismissed a second later, or a reviewer asked for changes in between.
  if (error === "review_required")
    return "This pull request needs an approving review of its current head, and does not have one. Nothing was merged.";
  if (error === "checks_required")
    return "This pull request needs a passing deploy of its current head, and does not have one yet. Nothing was merged.";
  if (error === "forbidden" || error === "unauthorized")
    return NO_WRITE_ACCESS;
  return PULL_GONE;
}

// ---- verdicts and threads ----

/**
 * The control for an origin fork's pull: it runs nothing here until a person
 * who can write this repository approves this head. Shown only while that
 * is the state of things.
 */
export function approveHereCard(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  headOid: string,
  action: string,
): Html {
  const user = ctx.auth.user;
  if (
    user === undefined ||
    user.kind !== "user" ||
    (pull.originHeadRepo === null && !isProposed(ctx.app.db, pull)) ||
    pull.state !== "open" ||
    pull.mergedAt !== null ||
    !canWrite(ctx.app.db, repo, user) ||
    pullMayRun(ctx.app.db, repo, pull, headOid)
  )
    return html``;
  const proposed = isProposed(ctx.app.db, pull);
  return card(
    html`<form method="post" action="${action}">
      <p>
        ${proposed
          ? "A child forge proposed this head, so its check and preview wait for you. Letting it run is not a review and does not count toward one; it runs this exact code here, holding the repository owner's app token. A new push waits again."
          : "This head is from a fork on the origin, so its check and preview wait for you. Approving lets them run this exact code here; it holds the repository's secrets only once it is approved as a guest too. A new push waits again."}
      </p>
      ${btn(proposed ? "Let it run here" : "Approve to run here", { size: "sm", icon: "check" })}
    </form>`,
    {
      extra: "mb bare",
      head: html`${icon("eye")}
        <h2>Run this code?</h2>`,
    },
  );
}

/** POST /:owner/:name/pulls/:number/approve-here — let a fork's head run. */
export async function pullApproveHereSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const done = await approveToRun(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
  );
  if (!done.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        done.error === "forbidden" || done.error === "unauthorized"
          ? "Only a person with write access can approve code to run here."
          : done.error === "self_review"
            ? reviewWords.selfReview
            : done.error === "not_open"
              ? "That pull request is closed."
              : done.error === "not_foreign"
                ? "That pull request needs no approval to run."
                : PULL_GONE,
    });
  return flashTo(ctx, dest, {
    message: isProposed(ctx.app.db, found.pull)
      ? "Let run here: its check and preview are starting. This is not a review."
      : "Approved to run here: its check and preview are starting.",
  });
}

/**
 * POST /:owner/:name/pulls/:number/review-state — pass a verdict.
 *
 * One endpoint, one verb, and the two refusals that matter get their own
 * sentences: a reader cannot approve (that is what makes "require review"
 * mean anything) and an author cannot approve their own change (that is the
 * whole point of requiring one). Both are decided in `submitReview`; this
 * only puts them into words.
 */
export async function pullReviewStateSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  // A refusal goes back to the form, on the Files step; a verdict that
  // landed is shown where it now reads, in the change's conversation.
  const refused = `${dest}/files`;
  const state = field(form, "state");
  if (!isReviewState(state))
    return flashTo(ctx, refused, {
      tone: "danger",
      message: "Pick approve, request changes, or comment.",
    });
  const bodyText = field(form, "body").trim();
  const submitted = await submitReview(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    { state, ...(bodyText === "" ? {} : { body: bodyText }) },
  );
  if (!submitted.ok) {
    const error = submitted.error;
    return flashTo(ctx, refused, {
      tone: "danger",
      message:
        originError(error) ??
        (error === "self_review"
          ? reviewWords.selfReview
          : error === "forbidden"
            ? `${reviewWords.forbidden} You can still leave a comment.`
            : error === "body_too_long"
              ? reviewWords.tooLong
              : error === "invalid_state"
                ? "That is not a verdict this forge knows."
                : "That review could not be recorded."),
    });
  }
  return flashTo(ctx, `${dest}#conversation`, {
    message:
      state === "approved"
        ? "Approved."
        : state === "changes_requested"
          ? "Changes requested."
          : "Review posted.",
  });
}

/** POST …/pulls/:number/threads/:anchor/{resolve,unresolve}. */
export function threadResolveSubmit(
  resolved: boolean,
): (ctx: Ctx) => Promise<Response> {
  return async (ctx: Ctx): Promise<Response> => {
    const found = pullContext(ctx);
    if (found instanceof Response) return found;
    if (!ctx.auth.user) return signInFirst(ctx);
    const form = await readForm(ctx, "rw");
    if (form instanceof Response) return form;

    const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
    const anchor = ctx.params.anchor ?? "";
    // The anchor is a hex digest and nothing else; anything shaped
    // differently never reaches a query.
    if (!/^[0-9a-f]{16}$/.test(anchor)) return notFoundPage(ctx);
    const changed = resolveReviewThread(
      ctx.app,
      ctx.auth.user,
      found.repo,
      found.pull,
      anchor,
      resolved,
    );
    if (!changed.ok)
      return flashTo(ctx, `${dest}/files`, {
        tone: "danger",
        message:
          changed.error === "not_found"
            ? "That thread is not here any more."
            : "Only someone in the thread, or a writer, can settle it.",
      });
    return flashTo(ctx, `${dest}/files`, {
      message: resolved ? "Thread resolved." : "Thread reopened.",
    });
  };
}

// POST /:owner/:name/pulls/:number/checks — ask for a check at the head now.
export async function pullChecksSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user || !canWrite(ctx.app.db, found.repo, ctx.auth.user))
    return forbiddenPage(ctx, "Only someone who can write to this repository can do this.");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  // The home's card asks to come back to the home (only "/" is honoured).
  const dest =
    field(form, "next") === "/" ? "/" : `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const asked = await askCheck(ctx.app, ctx.auth.user, found.repo, found.pull);
  return flashTo(
    ctx,
    dest,
    asked.ok
      ? { message: CHECK_ASKED }
      : { tone: "danger", message: `No check was asked for: ${asked.message}.` },
  );
}

// POST /:owner/:name/pulls/:number/merge
export async function pullMergeSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user || !canWrite(ctx.app.db, found.repo, ctx.auth.user))
    return forbiddenPage(ctx, "Only someone who can write to this repository can do this.");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const strategy = field(form, "strategy") === "squash" ? "squash" : "merge";
  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const result = await mergePull(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    strategy,
  );
  if (!result.ok) {
    return flashTo(ctx, `${dest}/files`, {
      tone: "danger",
      message: mergeFailure(result.error),
    });
  }
  return flashTo(ctx, dest, { message: "Pull request merged." });
}

// POST /:owner/:name/pulls/:number/slice — land the author's commits up to one (#9010).
export async function pullSliceSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user || !canWrite(ctx.app.db, found.repo, ctx.auth.user))
    return forbiddenPage(ctx, "Only someone who can write to this repository can do this.");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const landed = await landSlice(ctx.app, ctx.auth.user, found.repo, found.pull, field(form, "upTo") ?? "");
  if (!landed.ok)
    return flashTo(ctx, `${dest}/files`, {
      tone: "danger",
      message:
        landed.error === "bad_slice"
          ? "That commit is not one of this pull's that the base still lacks. Nothing landed."
          : landed.error === "sealed"
            ? "This pull's work is sealed apart from the base; it lands whole."
            : landed.error === "not_fork"
              ? "Only a pull from a fork lands in slices; this one lands whole."
              : landed.error === "held"
                ? "A hold stands on this pull: nothing of it lands until it is released."
                : landed.error === "forbidden" && ctx.auth.user.kind === "agent"
                  ? "The crew proposes and a person lands: an agent cannot land a slice."
                  : mergeFailure(landed.error),
    });
  return flashTo(ctx, landed.value.last ? dest : `${dest}/files`, {
    message: landed.value.last
      ? "Last slice landed: the pull is merged."
      : `Slice landed. ${landed.value.left} commit${landed.value.left === 1 ? "" : "s"} left.`,
  });
}

/**
 * The slices card (#9010): which slices of a fork's pull landed, what is
 * left, and — for a writer — a form to land the author's commits up to one
 * of them as their own merge commit.
 */
export function slicesCard(
  base: string,
  thread: string,
  slices: readonly LandedSlice[],
  left: number,
  commits: readonly { oid: string; subject: string }[],
  open: boolean,
  mayMerge: boolean,
): Html {
  if (slices.length === 0 && !(open && mayMerge && left > 1)) return html``;
  return card(
    html`${when(
        slices.length > 0,
        () => html`<ul class="list">
          ${slices.map(
            (s, i) => html`<li>
              <a class="row" href="${base}/commit/${s.mergeOid}">
                <span class="row-main">
                  <span class="row-title">Slice ${i + 1}: up to ${sha(s.upTo)}</span>
                  <span class="row-meta">merged as they are</span>
                </span>
                <span class="row-trail">${sha(s.mergeOid)}</span>
              </a>
            </li>`,
          )}
        </ul>`,
      )}
      <p class="muted small">
        ${open ? html`${left} commit${left === 1 ? "" : "s"} left to land.` : html`Nothing left: the last slice was the author's head.`}
      </p>
      ${when(
        open && mayMerge && commits.length > 1,
        () => html`<form method="post" action="${thread}/slice">
          ${selectField({
            label: "Land the author's commits up to",
            name: "upTo",
            id: "slice-up-to",
            hint: "Each slice is its own merge of the author's commits as they are. It lands only while the head's review and check would let the whole pull land.",
            options: commits.map((c, i) => ({
              value: c.oid,
              label: `${c.oid.slice(0, 7)} ${c.subject}${i === commits.length - 1 ? " (head: the last slice)" : ""}`,
            })),
          })}
          ${btn("Land slice", { icon: "merge" })}
        </form>`,
      )}`,
    {
      extra: "bare",
      head: html`${icon("merge")}
        <h2>Slices</h2>`,
    },
  );
}

// POST /:owner/:name/pulls/:number/land-past — the owner's break-glass (#7790).
export async function pullLandPastSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const user = ctx.auth.user;
  if (!user || user.kind === "agent" || !canAdmin(ctx.app.db, found.repo, user))
    return forbiddenPage(ctx, "Only a person who administers this repository can do this.");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const landed = await landPastGate(ctx.app, user, found.repo, found.pull, field(form, "reason") ?? "");
  if (!landed.ok) return flashTo(ctx, dest, { tone: "danger", message: bypassWords(landed.error) });
  return flashTo(ctx, dest, { message: "Landed past the gate; the reason is on the trail." });
}

function bypassWords(e: BypassError): string {
  switch (e.kind) {
    case "reason":
      return "Say why in 8 to 500 characters: it goes on the pull's trail.";
    case "not_stopped":
      return "Landing has not stopped, so there is no way past the gate: wait for the checks.";
    case "merge":
      return `Not landed: ${mergeFailure(e.error)}`;
    default:
      return "Only an owner can land a pull past the gate.";
  }
}

/**
 * GET /:owner/:name/pulls/:number/checks-line — the checks line alone, for
 * the region that shows it. Authorized as the page is: a viewer who cannot
 * read the pull gets the same 404.
 */
export async function pullChecksFragment(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return fragment(html``, { status: 404 });
  const { repo, pull } = found;
  const dir = await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);
  const isApp = getAppByRepo(ctx.app.db, repo.id) !== undefined;
  // The beat asks every 5 seconds while a check runs: answer from the stored
  // head without the merge reading or the base tip, which a running line
  // does not show. Anything else takes the full road below.
  const quick = checkSummary(ctx.app.db, pull.id, pull.headOid);
  if (quick.state === "running" || quick.state === "queued") {
    const status: PullStatus = {
      baseOid: pull.baseOid,
      headOid: pull.headOid,
      ahead: 0,
      mergeable: false,
      conflicts: [],
      reviews: null,
    };
    const tier = await tierOf(dir, pull.headOid, quick);
    return fragment(
      html`<div>${pullChecksLine(ctx, repo, pull, status, quick, isApp, tier)}</div>`,
      { request: ctx.request },
    );
  }
  const status = await pullStatus(dir, pull, {
    db: ctx.app.db,
    requireReview: repo.requireReview,
  });
  return fragment(
    html`<div>${await pullChecksLineFor(ctx, repo, pull, status, dir)}</div>`,
    { request: ctx.request },
  );
}

/**
 * The checks line with everything the page and the route both derive for it
 * (the check, the tier words, an older base), so a page that draws it at first
 * paint and the route that refreshes it say the same thing.
 */
export async function pullChecksLineFor(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  status: PullStatus,
  dir: string,
): Promise<Html> {
  const check = checkSummary(ctx.app.db, pull.id, status.headOid);
  const isApp = getAppByRepo(ctx.app.db, repo.id) !== undefined;
  const tier = await tierOf(dir, status.headOid, check);
  const stale =
    pull.state === "open" && pull.mergedAt === null
      ? checkStale(check.run, status.baseOid)
      : false;
  return pullChecksLine(ctx, repo, pull, status, check, isApp, tier, stale);
}
