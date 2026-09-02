/**
 * One pull request: the conversation, the merge box, and the files tab where
 * a review comment is anchored to the diff line the cursor is standing on.
 *
 * The merge box states are the whole point of the screen — a reviewer needs
 * to know in one glance whether this can land, and why not when it cannot.
 * It reads a `RepoSource`, so a pull on another forge renders in the same
 * shape; what it cannot do there is merge it, comment on it, or review a
 * line of it, and those keys are absent rather than present-and-failing.
 */

import {
  addCommentThrough,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { addReview, mergePull } from "../../actions/pulls.ts";
import { getIssue } from "../../core/issues.ts";
import { getPull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import {
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
} from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { G, type Span } from "../term/screen.ts";
import { BOLD, ITALIC, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { badge, card, tabs } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ORIGIN_MARK,
  Scroll,
  confirmScreen,
  drawLines,
  errorText,
  plural,
  relTime,
  runAsync,
} from "./common.ts";
import { DiffView, type DiffAnchor } from "./commits.ts";
import { liveBindings, liveKey } from "./mirror.ts";
import { Composer, threadLines, type ThreadEntry } from "./thread.ts";
import { local, localRepo, whereRows, whereStrip } from "./where.ts";

type Tab = 0 | 1;

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
  let lines: Span[][] = [];
  let width = 0;
  let tab: Tab = keep.tab ?? 0;
  let anchor: DiffAnchor | null = null;
  const scroll = new Scroll();
  const view = new DiffView();
  const composer = new Composer();
  const repo = localRepo(src);
  const mayWrite = (): boolean => src.capabilities.write && repo !== undefined;
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
    reviews =
      row === undefined
        ? []
        : withOutdated(listReviewComments(f.db, row.id), diff);
    view.setFiles(diff.files);
    view.setNotes(reviewNotes(reviews, ctx));
    width = 0;
    ctx.invalidate();
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
  ];

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

  const mirrored = (): boolean => repo === undefined || repo.origin !== null;
  const state = (): MergeState => mergeState(detail?.issue, facts, mirrored());

  const screen: Screen = {
    title: `#${number}`,
    get keys() {
      return [
        binding(["tab"], "conversation/files"),
        ...(tab === 1 ? view.keys : [binding(["j", "k"], "scroll")]),
        ...(mayWrite()
          ? [
              binding(["c"], tab === 1 ? "review line" : "comment"),
              binding(["m"], "merge", { disabled: state() !== "ready" }),
              binding(["x"], "close"),
            ]
          : liveBindings(src)),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      if (repo !== undefined) {
        const off = f.app.bus.subscribe((event) => {
          if (event.repoId === repo.id) runAsync(ctx, reload);
        });
        signal.addEventListener("abort", off);
      }
      return reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (!detail) return;
      const issue = detail.issue;
      const foot = composer.height();
      const [strip, head, boxRow, tabRow, body, comp] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        len(3),
        len(2),
        fill(1),
        len(Math.min(foot, Math.max(0, area.h - 10 - whereRows(src)))),
      ]);
      whereStrip(s, strip!, c, f, src);
      // Same head as an issue: the number is a locator, the title is the page.
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
      drawMergeBox(s, boxRow!, c, issue, facts, view.summary(), mirrored());
      tabs(s, tabRow!, c, {
        items: [
          {
            label: "Conversation",
            count: conversation().length + reviews.length,
          },
          { label: "Files", count: diff.files.length },
        ],
        active: tab,
      });
      if (tab === 1) view.render(s, body!, c);
      else {
        if (width !== body!.w) {
          width = body!.w;
          lines = threadLines(entries(), Math.max(20, body!.w - 1), c);
        }
        drawLines(s, body!, c, scroll, lines);
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
        tab = tab === 0 ? 1 : 0;
        return true;
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
  | "ready"
  | "unknown";

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
  return pull.mergeable ? "ready" : "conflicts";
}

function drawMergeBox(
  s: Parameters<typeof card>[0],
  r: Parameters<typeof card>[1],
  c: Parameters<typeof card>[2],
  issue: IssueSummary,
  pull: PullFacts | null,
  summary: string,
  mirrored: boolean,
): void {
  const state = mergeState(issue, pull, mirrored);
  const tone =
    state === "merged"
      ? "merged"
      : state === "ready"
        ? "success"
        : state === "conflicts" || state === "closed"
          ? "danger"
          : state === "mirrored"
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
        ? "Closed without merging"
        : state === "mirrored"
          ? `Merge on the origin${issue.originUrl === null ? "" : ` — ${issue.originUrl}`}`
          : state === "conflicts"
            ? `Conflicts in ${plural(conflicts.length, "file")}: ${conflicts.slice(0, 3).join(", ")}`
            : state === "empty"
              ? "Nothing to merge — the base already has these commits"
              : `Ready to merge · ${summary}`;
  const x = badge(s, inner.x, inner.y, c, {
    text: state,
    variant: tone as "success",
  });
  s.text(
    x + 1,
    inner.y,
    truncate(text, Math.max(0, inner.w - (x - inner.x) - 1)),
    style(c.fg, c.card),
    inner.x + inner.w,
  );
}

/** Review comments as rows spliced into the diff under the line they mark. */
function reviewNotes(
  reviews: readonly AnchoredReview[],
  ctx: Ctx,
): Map<string, Span[][]> {
  const c = ctx.theme.c;
  const out = new Map<string, Span[][]>();
  for (const review of reviews) {
    if (review.outdated) continue;
    const key = anchorKey(review.path, review.side, review.line);
    const rows = out.get(key) ?? [];
    rows.push([
      { text: "      ", style: style(c.mutedFg, c.bg) },
      {
        text: ` ${review.authorName} `,
        style: style(c.accentFg, c.accent, BOLD),
      },
      {
        text: ` ${review.body.replace(/\s+/g, " ")}`,
        style: style(c.mutedFg, c.bg, ITALIC),
      },
    ]);
    out.set(key, rows);
  }
  return out;
}
