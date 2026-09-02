/**
 * One pull request: the conversation, the merge box, and the files tab where
 * a review comment is anchored to the diff line the cursor is standing on.
 *
 * The merge box states are the whole point of the screen — a reviewer needs
 * to know in one glance whether this can land, and why not when it cannot.
 */

import {
  addCommentThrough,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { addReview, mergePull } from "../../actions/pulls.ts";
import { listComments, type Comment } from "../../core/issues.ts";
import {
  getPull,
  pullDiff,
  type Pull,
  type PullStatus,
} from "../../core/pulls.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import {
  anchorKey,
  listReviewComments,
  withOutdated,
  type AnchoredReview,
} from "../../core/reviews.ts";
import type { Diff } from "../../git/diff.ts";
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
import { Composer, threadLines, type ThreadEntry } from "./thread.ts";

type Tab = 0 | 1;

export function pullScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  number: number,
): Screen {
  let pull: Pull | undefined;
  let status: PullStatus | undefined;
  let diff: Diff = { files: [], additions: 0, deletions: 0 };
  let comments: Comment[] = [];
  let reviews: AnchoredReview[] = [];
  let lines: Span[][] = [];
  let width = 0;
  let tab: Tab = 0;
  let anchor: DiffAnchor | null = null;
  const scroll = new Scroll();
  const view = new DiffView();
  const composer = new Composer();
  const mayWrite = (): boolean => canWrite(f.db, repo, f.user);

  const reload = async (): Promise<void> => {
    pull = getPull(f.db, repo.id, number);
    if (!pull) {
      ctx.toast(errorText("not_found"), "danger");
      ctx.pop();
      return;
    }
    const read = await pullDiff(f.dir(repo), pull);
    status = read.status;
    diff = read.diff;
    reviews = withOutdated(listReviewComments(f.db, pull.id), diff);
    const reviewIds = new Set(reviews.map((r) => r.id));
    comments = listComments(f.db, pull.id).filter((c) => !reviewIds.has(c.id));
    view.setFiles(diff.files);
    view.setNotes(reviewNotes(reviews, ctx));
    width = 0;
    ctx.invalidate();
  };

  // An imported author is the login on the *origin*: shown in its place, and
  // marked, so it is never mistaken for an account here.
  const who = (local: string, origin: string | null): string =>
    origin === null || origin === "" ? local : `${ORIGIN_MARK} ${origin}`;

  const entries = (): ThreadEntry[] => [
    ...(pull === undefined
      ? []
      : [
          {
            kind: "comment" as const,
            actor: who(pull.authorName, pull.originAuthor),
            at: pull.createdAt,
            body: pull.body === "" ? "_No description._" : pull.body,
            ...(pull.originUrl === null ? {} : { note: pull.originUrl }),
          },
        ]),
    ...comments.map((comment) => ({
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
    if (!pull) return;
    if (anchor !== null) {
      const at = anchor;
      const body = composer.value;
      runAsync(ctx, async () => {
        const added = await addReview(f.app, f.user, repo, pull!, {
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
    const target = pull;
    const text = composer.value;
    runAsync(ctx, async () => {
      const added = await addCommentThrough(f.app, f.user, repo, target, text);
      if (!added.ok) {
        ctx.toast(errorText(added.error), "danger");
        return;
      }
      composer.close();
      await reload();
      ctx.toast("comment posted", "success");
    });
    return;
    composer.close();
    runAsync(ctx, reload);
    ctx.toast("comment posted", "success");
  };

  const merge = (strategy: "merge" | "squash"): void => {
    if (!pull) return;
    const target = pull;
    runAsync(ctx, async () => {
      const landed = await mergePull(f.app, f.user, repo, target, strategy);
      if (!landed.ok) {
        ctx.toast(errorText(String(landed.error)), "danger");
        return;
      }
      await reload();
      ctx.toast(`merged as ${landed.value.mergeOid.slice(0, 8)}`, "success");
    });
  };

  const screen: Screen = {
    title: `#${number}`,
    get keys() {
      return [
        binding(["tab"], "conversation/files"),
        ...(tab === 1 ? view.keys : [binding(["j", "k"], "scroll")]),
        binding(["c"], tab === 1 ? "review line" : "comment", {
          disabled: !f.signedIn,
        }),
        binding(["m"], "merge", {
          disabled:
            !mayWrite() ||
            mergeState(pull, status, repo.origin !== null) !== "ready",
        }),
        binding(["x"], "close", { disabled: !f.signedIn }),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      const off = f.app.bus.subscribe((event) => {
        if (event.repoId === repo.id) runAsync(ctx, reload);
      });
      signal.addEventListener("abort", off);
      return reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (!pull) return;
      const foot = composer.height();
      const [head, boxRow, tabRow, body, comp] = split(area, "v", [
        len(1),
        len(3),
        len(2),
        fill(1),
        len(Math.min(foot, Math.max(0, area.h - 10))),
      ]);
      // Same head as an issue: the number is a locator, the title is the page.
      const edge = head!.x + head!.w;
      const after = s.text(
        head!.x,
        head!.y,
        `#${pull.number} `,
        style(c.mutedFg, c.bg),
        edge,
      );
      s.text(
        after,
        head!.y,
        truncate(pull.title, Math.max(0, edge - after)),
        style(c.fg, c.bg, BOLD),
        edge,
      );
      drawMergeBox(s, boxRow!, c, pull, status, view.summary(), repo.origin !== null);
      tabs(s, tabRow!, c, {
        items: [
          { label: "Conversation", count: comments.length + reviews.length },
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
      if (e.key === "c" && f.signedIn) {
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
        pull &&
        mergeState(pull, status, repo.origin !== null) === "ready"
      ) {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Merge #${pull.number}`,
            body: [
              `${plural(status?.ahead ?? 0, "commit")} into ${pull.baseBranch}.`,
              repo.protectDefault && pull.baseBranch === repo.defaultBranch
                ? `${repo.defaultBranch} is protected; history is preserved.`
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
      if ((e.key === "x" || e.key === "o") && pull) {
        const target = pull;
        const wanted = e.key === "x" ? "closed" : "open";
        runAsync(ctx, async () => {
          const changed = await setIssueStateThrough(
            f.app,
            f.user,
            repo,
            target,
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

export function mergeState(
  pull: Pull | undefined,
  status: PullStatus | undefined,
  mirrored = false,
): MergeState {
  if (!pull) return "unknown";
  if (pull.mergedAt !== null) return "merged";
  if (pull.state === "closed") return "closed";
  // A mirror's merge belongs to the origin, which is truth for it: merging
  // here would rewrite the base branch and be overwritten by the next fetch.
  if (mirrored || pull.originHeadRepo !== null) return "mirrored";
  if (!status) return "unknown";
  if (status.ahead === 0) return "empty";
  return status.mergeable ? "ready" : "conflicts";
}

function drawMergeBox(
  s: Parameters<typeof card>[0],
  r: Parameters<typeof card>[1],
  c: Parameters<typeof card>[2],
  pull: Pull,
  status: PullStatus | undefined,
  summary: string,
  mirrored = false,
): void {
  const state = mergeState(pull, status, mirrored);
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
    footer: `${pull.headBranch} ${G.chevron} ${pull.baseBranch}${pull.crossRepo ? " (fork)" : ""} · ${summary}`,
  });
  const conflicts = status?.conflicts ?? [];
  const text =
    state === "merged"
      ? `Merged ${relTime(pull.mergedAt ?? "")} into ${pull.baseBranch}`
      : state === "closed"
        ? "Closed without merging"
        : state === "mirrored"
          ? `Merge on the origin${pull.originUrl === null ? "" : ` — ${pull.originUrl}`}`
          : state === "conflicts"
          ? `Conflicts in ${plural(conflicts.length, "file")}: ${conflicts.slice(0, 3).join(", ")}`
          : state === "empty"
            ? "Nothing to merge — the base already has these commits"
            : `Ready to merge · ${plural(status?.ahead ?? 0, "commit")}`;
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
