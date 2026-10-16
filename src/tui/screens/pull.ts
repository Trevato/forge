/**
 * One pull request: the conversation, the merge box, and the files tab where
 * a review comment is anchored to the diff line the cursor is standing on.
 *
 * The merge box states are the whole point of the screen — a reviewer needs
 * to know in one glance whether this can land, and why not when it cannot.
 * It reads a `RepoSource`, so a pull on another forge renders in the same
 * shape; what it cannot do there is merge it, comment on it, or review a
 * line of it, and those keys are absent rather than present-and-failing.
 *
 * Three things a review needs, and where each lives.
 *
 * - **The verdict** (`R`) is a decision about the change as a whole. It
 *   renders in the conversation as a timeline item with a state chip, and it
 *   is recorded against the head it was passed on — so a push after it
 *   dismisses it, and the item says `before the latest push` rather than
 *   quietly still counting.
 * - **The gate.** The merge box shows where the verdicts stand
 *   (`2 approvals · changes requested by bob`) and, on a repository with
 *   `require_review` on, refuses `m` with the reason. It is a *rendering* of
 *   the same rule `mergePull` enforces — the refusal is mechanical there,
 *   never here.
 * - **The threads.** Review comments sharing one anchor are one
 *   conversation. In the files tab `x` settles or reopens one (a writer, or
 *   whoever raised it), a settled thread collapses to a single dim line, and
 *   `n`/`p` walk the unsettled ones while the cursor is inside a thread.
 */

import {
  addCommentThrough,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import {
  addReview,
  approveHere,
  mergePull,
  pullThreads,
  resolveReviewThread,
  submitReview,
} from "../../actions/pulls.ts";
import { openEnvUrl } from "../../actions/apps.ts";
import { listRepoRuns } from "../../actions/runs.ts";
import { previewEnv } from "../../apps/data.ts";
import {
  appsRuntime,
  type EnvState,
  type EnvStatus, envsFor } from "../../apps/runtime.ts";
import { proposedByText } from "../../core/proposal_token.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { getIssue, type Issue } from "../../core/issues.ts";
import { pullMayRun } from "../../core/pull_trust.ts";
import { getPull, pullDir, variantSiblings, type Pull } from "../../core/pulls.ts";
import { voteVariant } from "../../actions/variants.ts";
import { getRepoById, type Repo } from "../../core/repos.ts";
import { checkSummary, type CheckSummary } from "../../core/runs.ts";
import { err, ok } from "../../kernel/result.ts";
import { getUsersByIds } from "../../core/users.ts";
import {
  anchorId,
  anchorKey,
  listReviewComments,
  withOutdated,
  type AnchoredReview,
} from "../../core/reviews.ts";
import type { Diff } from "../../git/diff.ts";
import type {
  IssueDetail,
  IssueSummary,
  PullFacts,
  RepoSource,
  ReviewFact,
} from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import {
  G,
  type Rect,
  type Screen as Surface,
  type Span,
} from "../term/screen.ts";
import { BOLD, ITALIC, style, type Color } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Tokens } from "../ui/theme.ts";
import { badge, card, dot, tabs, type Tone } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ORIGIN_MARK,
  Scroll,
  ago,
  confirmScreen,
  promptScreen,
  drawLines,
  hitScroll,
  errorText,
  live,
  metaOf,
  openLink,
  plural,
  relTime,
  runAsync,
} from "./common.ts";
import { assignPicker, assignedText } from "./assign.ts";
import { DiffView, type DiffAnchor, type DiffNote } from "./commits.ts";
import { liveBindings, liveKey } from "./mirror.ts";
import { pullConflicts } from "../../actions/conflicts.ts";
import { FINISH_REFUSALS, finishConflicts } from "../../actions/finish-conflicts.ts";
import { PROPOSE_WHY, proposalOf, proposeResolution } from "../../crew/proposal.ts";
import { conflictScreen } from "./conflicts.ts";
import { reviewScreen } from "./review.ts";
import { RunList, openRunLog, runTone } from "./runlist.ts";
import { Composer, threadLines, type ThreadEntry } from "./thread.ts";
import { local, localRepo, whereRows, whereStrip } from "./where.ts";
import { openAppTerminal } from "./apptty.ts";

/** One thread on the diff, as this screen holds it. */
interface Thread {
  readonly anchor: string;
  readonly path: string;
  readonly side: "old" | "new";
  readonly line: number;
  readonly resolvedAt: string | null;
  /** The account that settled it, resolved to a name a person recognises. */
  readonly resolvedBy: string;
  readonly comments: readonly { authorName: string; body: string }[];
}

/**
 * Where the verdicts stand at *this* head — the same reading `reviewGate`
 * makes in `core/pulls.ts`, over the shape a `RepoSource` hands a surface.
 *
 * The latest verdict per author wins (a reviewer who requested changes and
 * later approved counts once, as an approval), and only a verdict passed on
 * the current head counts at all, in either direction: new code is new code.
 */
export interface Standing {
  readonly approvals: number;
  /** Who is currently blocking, by name — a count alone says nothing useful. */
  readonly blocking: readonly string[];
  /** Verdicts a push has dismissed. */
  readonly stale: number;
}

export function standingOf(reviews: readonly ReviewFact[]): Standing {
  const latest = new Map<string, ReviewFact>();
  for (const review of reviews) latest.set(review.author, review);
  let approvals = 0;
  let stale = 0;
  const blocking: string[] = [];
  for (const review of latest.values()) {
    if (!review.current) {
      if (review.state !== "commented") stale++;
      continue;
    }
    if (review.state === "approved") approvals++;
    else if (review.state === "changes_requested") blocking.push(review.author);
  }
  return { approvals, blocking, stale };
}

/** `2 approvals · changes requested by bob` — the merge box's second line. */
export function standingText(standing: Standing, required: boolean): string {
  const parts = [
    standing.approvals === 0
      ? required
        ? "no approvals yet"
        : ""
      : plural(standing.approvals, "approval"),
    standing.blocking.length === 0
      ? ""
      : `changes requested by ${standing.blocking.join(", ")}`,
    standing.stale === 0 ? "" : `${standing.stale} dismissed by a push`,
  ].filter((part) => part !== "");
  return parts.join(" · ");
}

/** Conversation, files, and — when agents have worked here — the crew. */
type Tab = 0 | 1 | 2;

/** The checks on a pull, before any deploy has run. */
const NO_CHECK: CheckSummary = { state: "none", run: null };

/** What each verdict is called on screen — one wording, every surface. */
const VERDICT_WORDS: Record<ReviewFact["state"], string> = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
};

export function pullScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  number: number,
  keep: { tab?: Tab; top?: number } = {},
): Screen {
  let detail: IssueDetail | undefined;
  let facts: PullFacts | null = null;
  let diff: Diff = { files: [], additions: 0, deletions: 0 };
  let reviews: AnchoredReview[] = [];
  let threads: Thread[] = [];
  /** Settled threads the reader has opened back up, for this visit only. */
  const expanded = new Set<string>();
  let lines: Span[][] = [];
  let width = 0;
  let tab: Tab = keep.tab ?? 0;
  let anchor: DiffAnchor | null = null;
  const scroll = new Scroll();
  const view = new DiffView();
  const composer = new Composer();
  const repo = localRepo(src);
  /**
   * Whether this repository demands an approval, read on every reload rather
   * than off the row the screen opened with: a `Repo` handed down a stack is
   * a snapshot, and somebody turning the gate on in settings must change what
   * the merge box says without anybody re-entering the screen.
   */
  let requireReview = repo?.requireReview === true;
  /** The second gate, read the same way: a passing deploy of this head. */
  let requireChecks = repo?.requireChecks === true;
  /** The local issue row — who it is assigned to. Undefined on a live browse. */
  let issueRow: Issue | undefined;
  /** Whether the repository is an app, and its preview of this pull if so. */
  let isApp = false;
  let preview: EnvStatus | undefined;
  /** The deploy of the *current* head — what the merge box calls the checks. */
  let check: CheckSummary = NO_CHECK;
  /** The pull's base branch, to name what the check was merged with. */
  let checkBase = "";
  /** Agent runs about this pull, newest first. */
  const crew = new RunList(f);
  const mayWrite = (): boolean => src.capabilities.write && repo !== undefined;
  /** A writer, on a pull that is one of several variants. */
  const mayVote = (): boolean =>
    mayWrite() &&
    repo !== undefined &&
    getPull(f.db, repo.id, number)?.variantGroup != null;
  scroll.top = keep.top ?? 0;

  const reload = async (): Promise<void> => {
    const read = await src.issue(number);
    if (!read.ok) {
      ctx.toast(errorText(read.error), "danger");
      ctx.pop();
      return;
    }
    detail = read.value;
    facts = read.value.pull;
    diff = facts?.diff ?? { files: [], additions: 0, deletions: 0 };
    // Review comments are anchored rows in *our* database; a live browse has
    // none of them, and neither forge exposes an equivalent we could read.
    const row = repo === undefined ? undefined : getPull(f.db, repo.id, number);
    const settings =
      repo === undefined ? undefined : getRepoById(f.db, repo.id);
    requireReview = settings?.requireReview === true;
    requireChecks = settings?.requireChecks === true;
    reviews =
      row === undefined
        ? []
        : withOutdated(listReviewComments(f.db, row.id), diff);
    threads = row === undefined ? [] : readThreads(row);
    issueRow = repo === undefined ? undefined : getIssue(f.db, repo.id, number);
    // The app half: the preview environment (in memory, from the runtime),
    // the checks at the live head (a row), and what the crew has done here.
    const record = repo === undefined ? undefined : getAppByRepo(f.db, repo.id);
    isApp = record !== undefined;
    preview =
      record === undefined
        ? undefined
        : envsFor(f.app, f.user, record).find(
            (e) => e.env === previewEnv(number),
          );
    check =
      row === undefined
        ? NO_CHECK
        : checkSummary(f.db, row.id, row.headOid || (facts?.headOid ?? ""));
    checkBase = row?.baseBranch ?? facts?.baseBranch ?? "";
    const runs =
      repo === undefined || row === undefined
        ? undefined
        : listRepoRuns(f.app, f.user, repo, {
            kind: "agent",
            issueId: row.id,
            limit: 50,
          });
    crew.set(runs !== undefined && runs.ok ? runs.value : []);
    if (tab === 2 && crew.runs.length === 0) tab = 0;
    view.setFiles(diff.files);
    view.setNotes(threadNotes());
    width = 0;
    ctx.invalidate();
  };

  /**
   * The threads, with `resolved_by` turned into a name. The column stores a
   * user id (it is a foreign key), and "resolved by 01J9…" is not a sentence.
   * One grouped lookup for the whole page rather than one per thread.
   */
  const readThreads = (row: Pull): Thread[] => {
    const raw = pullThreads(f.app, row);
    const names = getUsersByIds(
      f.db,
      raw.flatMap((t) => (t.resolvedBy === null ? [] : [t.resolvedBy])),
    );
    return raw.map((t) => ({
      anchor: t.anchor,
      path: t.path,
      side: t.side,
      line: t.line,
      resolvedAt: t.resolvedAt,
      resolvedBy:
        t.resolvedBy === null
          ? ""
          : (names.get(t.resolvedBy)?.username ?? "somebody"),
      comments: t.comments.map((comment) => ({
        authorName: comment.authorName,
        body: comment.body,
      })),
    }));
  };

  /**
   * Review comments as rows spliced into the diff under the line they mark.
   *
   * A settled thread collapses to one dim line, because the point of settling
   * something is to stop looking at it — and `enter` opens it again, because
   * the point of a record is that it is still there.
   */
  const threadNotes = (): Map<string, DiffNote> => {
    const c = ctx.theme.c;
    const out = new Map<string, DiffNote>();
    for (const thread of threads) {
      const key = anchorKey(thread.path, thread.side, thread.line);
      const settled = thread.resolvedAt !== null;
      const open = !settled || expanded.has(thread.anchor);
      const rows: Span[][] = [];
      if (settled)
        rows.push([
          { text: "      ", style: style(c.mutedFg, c.bg) },
          {
            text: `${G.check} resolved${thread.resolvedBy === "" ? "" : ` by ${thread.resolvedBy}`} · ${relTime(thread.resolvedAt ?? "")} · enter to ${open ? "collapse" : "expand"}`,
            style: style(c.faint, c.bg, ITALIC),
          },
        ]);
      if (open)
        for (const comment of thread.comments)
          rows.push([
            { text: "      ", style: style(c.mutedFg, c.bg) },
            {
              text: ` ${comment.authorName} `,
              style: style(c.accentFg, c.accent, BOLD),
            },
            {
              text: ` ${comment.body.replace(/\s+/g, " ")}`,
              style: style(c.mutedFg, c.bg, ITALIC),
            },
          ]);
      out.set(key, {
        rows,
        thread: { anchor: thread.anchor, resolved: settled },
      });
    }
    return out;
  };

  // An imported author is the login on the *origin*: shown in its place, and
  // marked, so it is never mistaken for an account here.
  const who = (name: string, origin: string | null): string =>
    origin === null || origin === "" ? name : `${ORIGIN_MARK} ${origin}`;

  const reviewIds = (): Set<string> => new Set(reviews.map((r) => r.id));

  const conversation = (): {
    id: string;
    authorName: string;
    originAuthor: string | null;
    body: string;
    createdAt: string;
  }[] => (detail?.comments ?? []).filter((c) => !reviewIds().has(c.id));

  const entries = (): ThreadEntry[] => [
    ...(detail === undefined
      ? []
      : [
          {
            kind: "comment" as const,
            actor: who(detail.issue.authorName, detail.issue.originAuthor),
            at: detail.issue.createdAt,
            body: detail.body === "" ? "_No description._" : detail.body,
            ...(detail.issue.originUrl === null
              ? {}
              : { note: detail.issue.originUrl }),
          },
        ]),
    ...conversation().map((comment) => ({
      kind: "comment" as const,
      actor: who(comment.authorName, comment.originAuthor),
      at: comment.createdAt,
      body: comment.body,
    })),
    ...reviews.map((review) => ({
      kind: "comment" as const,
      actor: review.authorName,
      at: review.createdAt,
      body: review.body,
      note: `${review.path}:${review.line}${review.outdated ? " · outdated" : ""}`,
    })),
    ...verdicts().map(
      (review): ThreadEntry => ({
        kind: "comment" as const,
        actor: review.author,
        at: review.createdAt,
        body:
          review.body === ""
            ? `_${VERDICT_WORDS[review.state]}._`
            : review.body,
        badge: {
          text: VERDICT_WORDS[review.state],
          // A verdict a push has dismissed is muted, not green and not red:
          // it counts for nothing in either direction, and colouring it as
          // though it did is how a review gate becomes decorative.
          tone: !review.current
            ? "outline"
            : review.state === "approved"
              ? "success"
              : review.state === "changes_requested"
                ? "danger"
                : "outline",
        },
        ...(review.current ? {} : { note: "before the latest push" }),
      }),
    ),
  ];

  /** Every verdict on this pull, oldest first — the record, not the tally. */
  const verdicts = (): readonly ReviewFact[] => facts?.reviews ?? [];

  const standing = (): Standing => standingOf(verdicts());

  /**
   * The same reading `reviewGate` makes before a merge: an outstanding
   * request for changes blocks whatever the setting is, and `require_review`
   * additionally demands an approval of *this* head. Rendered here, enforced
   * in `mergePull` — this decides what the box says, never what may land.
   */
  const gated = (): boolean => {
    if (repo === undefined) return false;
    const now = standing();
    return now.blocking.length > 0 || (requireReview && now.approvals === 0);
  };

  /**
   * The checks gate: with `require_checks` on, the current head's deploy
   * must be `ok`. Rendered here; `mergePull` reads the row live and refuses
   * `checks_required` on its own.
   */
  const checksGated = (): boolean =>
    repo !== undefined && requireChecks && check.state !== "ok";

  /** `O` — the preview, through a grant when the app is private. */
  // Production beside the preview: comparing the two is the review.
  const openProduction = (): void => {
    if (repo === undefined || !isApp) return;
    const url = openEnvUrl(f.app, f.user, repo, "production");
    if (!url.ok) {
      ctx.toast(errorText(url.error), "danger");
      return;
    }
    openLink(ctx, url.value);
  };

  const openPreview = (): void => {
    if (repo === undefined || !isApp) return;
    const url = openEnvUrl(f.app, f.user, repo, previewEnv(number));
    if (!url.ok) {
      ctx.toast(errorText(url.error), "danger");
      return;
    }
    if (preview === undefined || preview.state !== "running")
      ctx.toast(
        `the preview is ${preview?.state ?? "not running"}; the page will say so`,
        "attn",
      );
    openLink(ctx, url.value);
  };

  /** `a` — hand the pull to a person, an agent, or nobody. */
  const assign = (): void => {
    if (repo === undefined || issueRow === undefined) return;
    assignPicker(f, ctx, screen, repo, issueRow, () => runAsync(ctx, reload));
  };

  /** The tabs that exist right now: the crew's only once it has worked here. */
  const tabCount = (): number => (crew.runs.length > 0 ? 3 : 2);

  const submit = (): void => {
    if (repo === undefined) return;
    const target = repo;
    const row = getPull(f.db, target.id, number);
    if (row === undefined) return;
    if (anchor !== null) {
      const at = anchor;
      const body = composer.value;
      runAsync(ctx, async () => {
        const added = await addReview(f.app, f.user, target, row, {
          body,
          path: at.path,
          line: at.line,
          side: at.side,
        });
        if (!added.ok) {
          ctx.toast(errorText(added.error), "danger");
          return;
        }
        composer.close();
        anchor = null;
        await reload();
        ctx.toast("review comment added", "success");
      });
      return;
    }
    const issue = getIssue(f.db, target.id, number);
    if (issue === undefined) return;
    const text = composer.value;
    runAsync(ctx, async () => {
      const added = await addCommentThrough(f.app, f.user, target, issue, text);
      if (!added.ok) {
        ctx.toast(errorText(added.error), "danger");
        return;
      }
      composer.close();
      await reload();
      ctx.toast("comment posted", "success");
    });
  };

  /** `R` — the verdict card, and the one call behind it. */
  const review = (): void => {
    if (repo === undefined) return;
    const target = repo;
    const row = getPull(f.db, target.id, number);
    if (row === undefined) return;
    ctx.push(
      reviewScreen(ctx, {
        parent: screen,
        title: `Review #${number}`,
        // The author of a change cannot approve it, so the option is not
        // there. `submitReview` refuses it as well (`self_review`) — this is
        // the rendering of that rule, never a substitute for it.
        mayApprove: f.user !== undefined && row.authorId !== f.user.id,
        head: facts?.headOid ?? "",
        submit: async (input) => {
          const sent = await submitReview(f.app, f.user, target, row, {
            state: input.state,
            ...(input.body.trim() === "" ? {} : { body: input.body.trim() }),
          });
          if (!sent.ok) return err(errorText(String(sent.error)));
          await reload();
          ctx.toast(
            `review submitted: ${VERDICT_WORDS[input.state]}`,
            "success",
          );
          return ok(sent.value);
        },
      }),
    );
  };

  /** `x` on a thread in the files view: settle it, or open it back up. */
  const settleThread = (anchor: string, resolved: boolean): void => {
    if (repo === undefined) return;
    const target = repo;
    const row = getPull(f.db, target.id, number);
    if (row === undefined) return;
    const done = resolveReviewThread(
      f.app,
      f.user,
      target,
      row,
      anchor,
      resolved,
    );
    if (!done.ok) {
      ctx.toast(errorText(done.error), "danger");
      return;
    }
    expanded.delete(anchor);
    runAsync(ctx, reload);
    ctx.toast(resolved ? "thread resolved" : "thread reopened", "success");
  };

  const merge = (strategy: "merge" | "squash"): void => {
    if (repo === undefined) return;
    const target = repo;
    const row = getPull(f.db, target.id, number);
    if (row === undefined) return;
    runAsync(ctx, async () => {
      const landed = await mergePull(f.app, f.user, target, row, strategy);
      if (!landed.ok) {
        ctx.toast(errorText(String(landed.error)), "danger");
        return;
      }
      await reload();
      ctx.toast(`merged as ${landed.value.mergeOid.slice(0, 8)}`, "success");
    });
  };

  /**
   * Whether `A` is on offer: an open origin-fork pull whose current head
   * nobody here has approved to run. The same condition as the page's card.
   */
  const mayApproveHere = (): boolean => {
    if (repo === undefined || f.user === undefined || !mayWrite()) return false;
    const row = getPull(f.db, repo.id, number);
    return (
      f.user.kind === "user" &&
      row !== undefined &&
      row.originHeadRepo !== null &&
      row.state === "open" &&
      row.mergedAt === null &&
      (facts?.headOid ?? "") !== "" &&
      !pullMayRun(f.db, repo, row, facts?.headOid ?? "")
    );
  };

  /** `A` — let this origin fork's head run here; `approveHere` decides. */
  const approveToRun = (): void => {
    if (repo === undefined) return;
    const target = repo;
    const row = getPull(f.db, target.id, number);
    if (row === undefined) return;
    runAsync(ctx, async () => {
      const done = await approveHere(f.app, f.user, target, row);
      if (!done.ok) {
        ctx.toast(errorText(String(done.error)), "danger");
        return;
      }
      await reload();
      ctx.toast("approved to run here: its check and preview start", "success");
    });
  };

  /** `v` — the conflict blocks, read; `pullConflicts` holds the writer gate. */
  const seeConflicts = (): void => {
    if (repo === undefined) return;
    const target = repo;
    const row = getPull(f.db, target.id, number);
    if (row === undefined) return;
    runAsync(ctx, async () => {
      const read = await pullConflicts(f.app, f.user, target, row);
      if (!read.ok) {
        ctx.toast(errorText(read.error), "danger");
        return;
      }
      const seen = read.value;
      ctx.push(
        conflictScreen(ctx, seen, async (path, choices) => {
          const fresh = getPull(f.db, target.id, number) ?? row;
          const done = await finishConflicts(f.app, f.user, target, fresh, {
            headOid: seen.headOid,
            baseOid: seen.baseOid,
            path,
            choices,
          });
          return done.ok
            ? { ok: true, message: "Conflicts resolved: committed to the branch." }
            : { ok: false, message: FINISH_REFUSALS[done.error] };
        }, {
          proposal: async () => {
            const fresh = getPull(f.db, target.id, number) ?? row;
            const dir = await pullDir(f.app.db, f.app.reposRoot, target, fresh);
            return proposalOf(f.app, target, fresh, dir);
          },
          propose: async () => {
            const fresh = getPull(f.db, target.id, number) ?? row;
            const made = await proposeResolution(f.app, f.user, target, fresh);
            return made.ok
              ? { ok: true, message: "Asked: the crew is resolving it on the pull's own branch." }
              : { ok: false, message: PROPOSE_WHY[made.error] };
          },
        }),
      );
    });
  };

  const mirrored = (): boolean => repo === undefined || repo.origin !== null;
  const state = (): MergeState =>
    mergeState(detail?.issue, facts, mirrored(), gated(), checksGated());

  const screen: Screen = {
    title: `#${number}`,
    get keys() {
      return [
        binding(["tab"], tabCount() === 3 ? "next tab" : "conversation/files"),
        ...(tab === 1
          ? view.keys
          : tab === 2
            ? [binding(["j", "k"], "move"), binding(["enter"], "open the run")]
            : [binding(["j", "k"], "scroll")]),
        ...(isApp && preview !== undefined
          ? [binding(["O"], "open the preview")]
          : []),
        ...(isApp ? [binding(["P"], "open production")] : []),
        ...(isApp && preview !== undefined
          ? [binding(["T"], "the preview's terminal")]
          : []),
        ...(mayWrite()
          ? [
              binding(["c"], tab === 1 ? "review line" : "comment"),
              binding(["R"], "review"),
              ...(mayVote() ? [binding(["+", "-"], "like/dislike a variant")] : []),
              ...(mayApproveHere()
                ? [binding(["A"], "approve to run here")]
                : []),
              binding(["a"], "assign"),
              ...(state() === "conflicts"
                ? [binding(["v"], "see the conflict blocks")]
                : []),
              binding(["m"], "merge", { disabled: state() !== "ready" }),
              ...(tab === 1 && view.threadHere() !== null
                ? [
                    binding(
                      ["x"],
                      view.threadHere()?.resolved === true
                        ? "reopen the thread"
                        : "resolve the thread",
                    ),
                  ]
                : [binding(["x"], "close")]),
            ]
          : liveBindings(src)),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      if (repo !== undefined)
        live(f, signal, { repoId: repo.id }, () => runAsync(ctx, reload));
      return reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (!detail) return;
      const issue = detail.issue;
      const foot = composer.height();
      // The box is exactly as tall as what is in it: the state, then a row
      // for the verdicts when there are any, then a row for the checks when
      // a deploy has run or the gate demands one.
      const checksLine = checksText(check, requireChecks, isApp, checkBase);
      const boxH =
        3 +
        (standingText(standing(), requireReview) === "" ? 0 : 1) +
        (checksLine === "" ? 0 : 1);
      const [strip, head, previewRow, boxRow, tabRow, body, comp] = split(
        area,
        "v",
        [
          len(whereRows(src)),
          len(2),
          len(isApp ? 1 : 0),
          len(boxH),
          len(2),
          fill(1),
          len(Math.min(foot, Math.max(0, area.h - 13 - whereRows(src)))),
        ],
      );
      whereStrip(s, strip!, c, f, src);
      // Same head as an issue: the number is a locator, the title is the page,
      // and the second row says who opened it and who is on it.
      const edge = head!.x + head!.w;
      const after = s.text(
        head!.x,
        head!.y,
        `#${issue.number} `,
        style(c.mutedFg, c.bg),
        edge,
      );
      s.text(
        after,
        head!.y,
        truncate(issue.title, Math.max(0, edge - after)),
        style(c.fg, c.bg, BOLD),
        edge,
      );
      const closed = issue.state !== "open";
      const x1 = dot(s, head!.x, head!.y + 1, c, {
        tone:
          facts?.mergedAt != null ? "merged" : closed ? "danger" : "success",
      });
      s.text(
        x1,
        head!.y + 1,
        truncate(
          ` ${facts?.mergedAt != null ? "merged" : issue.state} · opened by ${who(issue.authorName, issue.originAuthor)} ${ago(issue.createdAt)}${assignedText(issueRow, ctx.icons)}${facts?.proposal ? ` · ${proposedByText(facts.proposal)}` : ""}`,
          Math.max(0, edge - x1),
        ),
        style(c.mutedFg, c.bg),
        edge,
      );
      if (isApp && previewRow!.h > 0)
        drawPreviewLine(s, previewRow!, c, preview);
      drawMergeBox(s, boxRow!, c, issue, facts, view.summary(), mirrored(), {
        gated: gated(),
        checksGated: checksGated(),
        check,
        checksLine,
        standing: standing(),
        required: requireReview,
      });
      tabs(s, tabRow!, c, {
        items: [
          {
            label: "Conversation",
            count: conversation().length + reviews.length + verdicts().length,
          },
          { label: "Files", count: diff.files.length },
          ...(crew.runs.length > 0
            ? [{ label: "Crew", count: crew.runs.length }]
            : []),
        ],
        active: tab,
      });
      if (tab === 2) {
        crew.render(s, body!, c, ctx, true, (run) => {
          if (repo !== undefined) openRunLog(f, ctx, repo, run);
        });
      } else if (tab === 1) {
        // The thread count is a section header, not a badge on the tab: how
        // many conversations are still open is the question a reviewer opens
        // this tab to answer, and it deserves a line.
        const unsettled = threads.filter((t) => t.resolvedAt === null).length;
        if (threads.length === 0) {
          view.render(s, body!, c);
          hitScroll(ctx, body!, view.scroll, view.length);
        } else {
          const [note, files] = split(body!, "v", [len(1), fill(1)]);
          s.text(
            note!.x,
            note!.y,
            truncate(
              `${plural(threads.length, "thread")} · ${unsettled} unresolved`,
              note!.w,
            ),
            style(unsettled > 0 ? c.attn : c.mutedFg, c.bg),
            note!.x + note!.w,
          );
          view.render(s, files!, c);
          // The wheel moves the diff, threads and all — the pane a reviewer
          // spends the most time in was the one pane the pointer could not
          // touch.
          hitScroll(ctx, files!, view.scroll, view.length);
        }
      } else {
        if (width !== body!.w) {
          width = body!.w;
          lines = threadLines(entries(), Math.max(20, body!.w - 1), c);
        }
        drawLines(s, body!, c, scroll, lines);
        hitScroll(ctx, body!, scroll, lines.length);
      }
      if (foot > 0) composer.render(s, comp!, c, ctx);
    },
    paste: (text) => composer.paste(text),
    key(e) {
      if (composer.open) {
        const out = composer.key(e);
        if (out === "submit") submit();
        else if (out === "cancel") {
          composer.close();
          anchor = null;
        }
        return true;
      }
      if (e.key === "tab") {
        tab = ((tab + 1) % tabCount()) as Tab;
        return true;
      }
      if ((e.key === "+" || e.key === "-") && mayVote()) {
        const target = repo!;
        const vote = (answer: "like" | "dislike", reason = ""): void => {
          const row = getPull(f.db, target.id, number);
          if (row === undefined) return;
          const voted = voteVariant(f.app, f.user, target, row, answer, reason);
          if (!voted.ok) {
            ctx.toast(errorText(voted.error), "danger");
            return;
          }
          const others = variantSiblings(f.db, [row])[0] ?? [];
          ctx.toast(
            `${answer === "like" ? "Liked" : "Closed"}. Variants: ${others.map((n) => `#${n}`).join(" ") || "none"}`,
          );
          runAsync(ctx, reload);
        };
        if (e.key === "+") vote("like");
        else
          ctx.push(
            promptScreen(ctx, screen, {
              title: `Dislike and close #${number}`,
              label: "Why not this one",
              hint: "One line the builder reads. Enter closes it; Esc cancels.",
              onSubmit: (value) => {
                vote("dislike", value);
                return undefined;
              },
            }),
          );
        return true;
      }
      if (e.key === "R" && mayWrite()) {
        review();
        return true;
      }
      if (e.key === "A" && mayApproveHere()) {
        approveToRun();
        return true;
      }
      if (e.key === "O" && isApp && preview !== undefined) {
        openPreview();
        return true;
      }
      if (e.key === "P" && isApp) {
        openProduction();
        return true;
      }
      if (e.key === "T" && isApp && preview !== undefined && repo) {
        void openAppTerminal(f, ctx, repo, previewEnv(number));
        return true;
      }
      if (e.key === "a" && mayWrite()) {
        assign();
        return true;
      }
      if (e.key === "v" && mayWrite() && state() === "conflicts") {
        seeConflicts();
        return true;
      }
      // The crew tab is a list: the cursor moves, enter opens the run.
      if (tab === 2) {
        if (crew.state.key(e, crew.runs.length)) return true;
        if (e.key === "enter") {
          const run = crew.selected;
          if (run !== undefined && repo !== undefined)
            openRunLog(f, ctx, repo, run);
          return true;
        }
      }
      // A thread the cursor is standing in owns `x` and `enter` before the
      // screen does: settling a conversation is the act on offer there, and
      // closing the whole pull from inside one would be a surprise.
      if (tab === 1 && mayWrite()) {
        const here = view.threadHere();
        if (here !== null && (e.key === "x" || e.key === "enter")) {
          if (e.key === "x") settleThread(here.anchor, !here.resolved);
          else if (here.resolved) {
            // A settled thread is a record, not a deletion: enter opens it
            // back up to read, without reopening the conversation itself.
            if (expanded.has(here.anchor)) expanded.delete(here.anchor);
            else expanded.add(here.anchor);
            view.setNotes(threadNotes());
            ctx.invalidate();
          } else settleThread(here.anchor, true);
          return true;
        }
      }
      if (e.key === "c" && mayWrite()) {
        if (tab === 1) {
          const at = view.anchorAt();
          if (at === null) {
            ctx.toast("put the cursor on a diff line first", "attn");
            return true;
          }
          anchor = at;
          composer.start(`Review ${at.path}:${at.line}`);
        } else {
          anchor = null;
          composer.start("Comment");
        }
        return true;
      }
      // A merge the gate would refuse says so here rather than going quiet:
      // `m` doing nothing is indistinguishable from `m` being unbound.
      if (e.key === "m" && mayWrite() && state() === "review_required") {
        const now = standing();
        ctx.toast(
          now.blocking.length > 0
            ? `changes requested by ${now.blocking.join(", ")}`
            : errorText("review_required"),
          "attn",
        );
        return true;
      }
      if (e.key === "m" && mayWrite() && state() === "checks_required") {
        ctx.toast(checksRefusal(check), "attn");
        return true;
      }
      if (
        e.key === "m" &&
        mayWrite() &&
        facts !== null &&
        state() === "ready"
      ) {
        const base = facts.baseBranch;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Merge #${number}`,
            body: [
              `${view.summary()} into ${base}.`,
              repo?.protectDefault === true && base === repo.defaultBranch
                ? `${base} is protected; history is preserved.`
                : "",
            ],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Squash", variant: "secondary" },
              { label: "Merge" },
            ],
            selected: 2,
            onChoose: (choice) => {
              if (choice === 1) merge("squash");
              if (choice === 2) merge("merge");
            },
          }),
        );
        return true;
      }
      // `o` on an open pull with a preview opens the preview; on a closed
      // one it reopens the pull, as it always has. Nothing is lost: the
      // "reopen" reading only ever meant something on a closed pull.
      if (
        e.key === "o" &&
        isApp &&
        preview !== undefined &&
        detail?.issue.state === "open"
      ) {
        openPreview();
        return true;
      }
      if (
        (e.key === "x" || e.key === "o") &&
        mayWrite() &&
        repo !== undefined
      ) {
        const issue = getIssue(f.db, repo.id, number);
        if (issue === undefined) return true;
        const target = repo;
        const wanted = e.key === "x" ? "closed" : "open";
        runAsync(ctx, async () => {
          const changed = await setIssueStateThrough(
            f.app,
            f.user,
            target,
            issue,
            wanted,
          );
          if (!changed.ok) ctx.toast(errorText(changed.error), "danger");
          else await reload();
        });
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }
      if (
        liveKey(f, ctx, e, src, {
          parent: screen,
          onDone: (next: Repo) =>
            ctx.replace(
              pullScreen(f, ctx, local(f, next), number, {
                tab,
                top: scroll.top,
              }),
            ),
        })
      )
        return true;
      if (tab === 2) return true;
      return tab === 1 ? view.key(e, ctx) : scroll.key(e, lines.length);
    },
  };
  return screen;
}

export type MergeState =
  | "merged"
  | "closed"
  | "mirrored"
  | "conflicts"
  | "empty"
  /** The verdicts do not let this land yet — `mergePull` refuses it too. */
  | "review_required"
  /** The head's deploy is not green yet — `mergePull` refuses it too. */
  | "checks_required"
  | "ready"
  | "unknown";

/** The tone an environment's state wears; `stopped` and `asleep` wear none. */
function envTone(state: EnvState): Tone | undefined {
  switch (state) {
    case "running":
      return "success";
    case "deploying":
      return "attn";
    case "failed":
      return "danger";
    case "stopped":
    case "asleep":
      return undefined;
  }
}

/**
 * The preview, in one line: a dot in the environment's tone, the word, the
 * URL as a link, and the error when there is one — never "failed" alone.
 */
function drawPreviewLine(
  s: Surface,
  r: Rect,
  c: Tokens,
  preview: EnvStatus | undefined,
): void {
  const right = r.x + r.w;
  const tone = preview === undefined ? undefined : envTone(preview.state);
  let x = dot(s, r.x, r.y, c, {
    ...(tone === undefined ? { hollow: true } : { tone }),
  });
  x = s.text(x + 1, r.y, "preview ", style(c.mutedFg, c.bg), right);
  if (preview === undefined) {
    s.text(
      x,
      r.y,
      "none — a preview runs while the pull is open",
      style(c.faint, c.bg),
      right,
    );
    return;
  }
  const words =
    preview.state === "failed"
      ? `failed: ${preview.error ?? "the deploy did not finish"}`
      : preview.state === "running"
        ? `running${preview.since === undefined ? "" : ` since ${ago(preview.since)}`}`
        : preview.state === "deploying"
          ? `deploying ${preview.commitOid.slice(0, 7)}`
          : preview.state === "asleep"
            ? `asleep${preview.since === undefined ? "" : ` since ${ago(preview.since)}`}; wakes on a request`
            : preview.dormant === undefined
            ? "stopped"
            : `asleep since ${ago(preview.dormant.since)}; nobody touched the change since ${ago(preview.dormant.idleSince)}`;
  x = s.text(
    x,
    r.y,
    truncate(words, Math.max(0, right - x)),
    style(tone === undefined ? c.mutedFg : toneColor(c, tone), c.bg),
    right,
  );
  if (preview.state !== "failed")
    s.linkText(
      x + 2,
      r.y,
      truncate(preview.url, Math.max(0, right - x - 2)),
      style(c.mutedFg, c.bg),
      preview.url,
      right,
    );
}

function toneColor(c: Tokens, tone: Tone): Color {
  return tone === "success"
    ? c.success
    : tone === "danger"
      ? c.danger
      : tone === "attn"
        ? c.attn
        : tone === "merged"
          ? c.merged
          : c.mutedFg;
}

/**
 * The checks row of the merge box: what the current head's deploy did.
 * Empty when nothing has deployed and nothing demands it — a box row that
 * says "no checks" on a repository that is not an app is noise.
 */
export function checksText(
  check: CheckSummary,
  required: boolean,
  isApp: boolean,
  baseBranch = "",
): string {
  if (check.state === "none")
    return required
      ? "checks: none yet — a deploy of this head is required"
      : isApp
        ? "checks: no deploy of this head yet"
        : "";
  const run = check.run;
  const summary = `${
    run === null || run.summary === "" ? "" : ` · ${run.summary}`
  }${
    run !== null && run.baseOid !== "" && baseBranch !== ""
      ? ` · checked against ${baseBranch} at ${run.baseOid.slice(0, 7)}`
      : ""
  }`;
  switch (check.state) {
    case "ok":
      return `checks: passed${summary}`;
    case "failed":
      return `checks: failed${summary}`;
    case "running":
      return "checks: deploying this head";
    case "queued":
      return `checks: a deploy of this head is queued${
        run === null ? "" : ` (queued ${relTime(run.createdAt)})`
      }`;
    case "cancelled":
      return `checks: the deploy was cancelled${summary}`;
  }
}

/** Why `m` is refused by the checks gate, in words a person can act on. */
export function checksRefusal(check: CheckSummary): string {
  switch (check.state) {
    case "failed":
      return `the deploy of this head failed${check.run?.summary ? `: ${check.run.summary}` : ""}`;
    case "running":
    case "queued":
      return "wait for the deploy of this head to pass";
    default:
      return errorText("checks_required");
  }
}

/**
 * What the merge box says, from what the source could tell us.
 *
 * `PullFacts` carries no commit count, so "nothing to merge" is read off the
 * diff instead: a pull whose base already has its commits has no files in it.
 */
export function mergeState(
  issue: IssueSummary | undefined,
  pull: PullFacts | null | undefined,
  mirrored = false,
  gated = false,
  checksGated = false,
): MergeState {
  if (issue === undefined || pull === null || pull === undefined)
    return "unknown";
  if (pull.mergedAt !== null) return "merged";
  if (issue.state === "closed") return "closed";
  // A mirror's merge belongs to the origin, which is truth for it: merging
  // here would rewrite the base branch and be overwritten by the next fetch.
  if (mirrored) return "mirrored";
  if (pull.mergeable === null) return "unknown";
  if (pull.diff !== null && pull.diff.files.length === 0) return "empty";
  if (!pull.mergeable) return "conflicts";
  // Git could take it; the reviewers have not. Said after the conflict check
  // because a conflict is the more urgent of the two and only one line fits.
  // The checks come after the reviewers for the same reason: a person's
  // objection outranks a machine's.
  return gated ? "review_required" : checksGated ? "checks_required" : "ready";
}

function drawMergeBox(
  s: Parameters<typeof card>[0],
  r: Parameters<typeof card>[1],
  c: Parameters<typeof card>[2],
  issue: IssueSummary,
  pull: PullFacts | null,
  summary: string,
  mirrored: boolean,
  o: {
    gated: boolean;
    checksGated: boolean;
    check: CheckSummary;
    /** The checks row, already worded; "" draws none. */
    checksLine: string;
    standing: Standing;
    required: boolean;
  },
): void {
  const state = mergeState(issue, pull, mirrored, o.gated, o.checksGated);
  const tone =
    state === "merged"
      ? "merged"
      : state === "ready"
        ? "success"
        : state === "conflicts" || state === "closed"
          ? "danger"
          : state === "mirrored" ||
              state === "review_required" ||
              state === "checks_required"
            ? "attn"
            : "default";
  // Where it is going belongs on the frame, not on a body row: the box is
  // three rows tall, so a second body row would paint over the bottom rule.
  const inner = card(s, r, c, {
    tone: tone as "success",
    title: "Merge",
    footer:
      pull === null
        ? summary
        : `${pull.headBranch} ${G.chevron} ${pull.baseBranch} · ${summary}`,
  });
  const conflicts = pull?.conflicts ?? [];
  const text =
    state === "merged"
      ? `Merged ${relTime(pull?.mergedAt ?? "")} into ${pull?.baseBranch ?? ""}`
      : state === "closed"
        ? issue.parked === true
          ? "Parked by the crew, not merged"
          : "Closed without merging"
        : state === "mirrored"
          ? `Merge on the origin${issue.originUrl === null ? "" : ` — ${issue.originUrl}`}`
          : state === "conflicts"
            ? `Conflicts in ${plural(conflicts.length, "file")}: ${conflicts.slice(0, 3).join(", ")}`
            : state === "empty"
              ? "Nothing to merge — the base already has these commits"
              : state === "review_required"
                ? o.standing.blocking.length > 0
                  ? `Changes requested by ${o.standing.blocking.join(", ")}`
                  : "Needs an approval of this head before it can merge"
                : state === "checks_required"
                  ? o.check.state === "failed"
                    ? "The deploy of this head failed; it cannot merge until one passes"
                    : o.check.state === "running" || o.check.state === "queued"
                      ? "Waiting for the deploy of this head to pass"
                      : "Needs a passing deploy of this head before it can merge"
                  : `Ready to merge · ${summary}`;
  const x = badge(s, inner.x, inner.y, c, {
    text:
      state === "review_required"
        ? "review"
        : state === "checks_required"
          ? "checks"
          : state,
    variant: tone as "success",
  });
  s.text(
    x + 1,
    inner.y,
    truncate(text, Math.max(0, inner.w - (x - inner.x) - 1)),
    style(c.fg, c.card),
    inner.x + inner.w,
  );
  // Where the verdicts stand, under the state. Two rows only when there is
  // something to say — a box with an empty second line reads as a box that
  // lost something.
  const verdicts = standingText(o.standing, o.required);
  let y = inner.y + 1;
  if (verdicts !== "" && y < inner.y + inner.h) {
    s.text(
      inner.x,
      y,
      truncate(verdicts, inner.w),
      style(o.standing.blocking.length > 0 ? c.danger : c.mutedFg, c.card),
      inner.x + inner.w,
    );
    y++;
  }
  // The checks, under the verdicts: a deploy's outcome in the tone a run
  // wears everywhere else, with its summary — the failed one names why.
  if (o.checksLine !== "" && y < inner.y + inner.h) {
    const checkTone = runTone(
      o.check.state === "none" ? "queued" : o.check.state,
    );
    s.text(
      inner.x,
      y,
      truncate(o.checksLine, inner.w),
      style(
        checkTone === undefined ? c.mutedFg : toneColor(c, checkTone),
        c.card,
      ),
      inner.x + inner.w,
    );
  }
}
