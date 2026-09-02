/**
 * One issue: the conversation, the composer, and the state and label changes
 * a participant is allowed to make.
 *
 * It subscribes to the event bus for its repo while it is on the stack, so a
 * comment posted from the web (or by another terminal) appears without a
 * keypress. The subscription is released by the screen's own abort signal —
 * popping the screen is what unsubscribes it, with no lifecycle hook needed.
 */

import {
  addComment,
  setIssueLabels,
  setIssueState,
} from "../../actions/issues.ts";
import {
  getIssue,
  labelsFor,
  listComments,
  listLabels,
  type Comment,
  type Issue,
  type Label,
} from "../../core/issues.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { dot, labelChip } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Scroll,
  ago,
  drawLines,
  errorText,
  pickerScreen,
  plural,
  runAsync,
} from "./common.ts";
import { Composer, threadLines, type ThreadEntry } from "./thread.ts";

export function issueScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  number: number,
): Screen {
  let issue: Issue | undefined;
  let comments: Comment[] = [];
  let marks: Label[] = [];
  let lines: Span[][] = [];
  let width = 0;
  const scroll = new Scroll();
  const composer = new Composer();
  const mayWrite = (): boolean => canWrite(f.db, repo, f.user);

  const reload = (): void => {
    issue = getIssue(f.db, repo.id, number);
    if (!issue) {
      ctx.toast(errorText("not_found"), "danger");
      ctx.pop();
      return;
    }
    comments = listComments(f.db, issue.id);
    marks = labelsFor(f.db, issue.id);
    width = 0;
    ctx.invalidate();
  };

  const entries = (): ThreadEntry[] => [
    ...(issue === undefined
      ? []
      : [
          {
            kind: "comment" as const,
            actor: issue.authorName,
            at: issue.createdAt,
            body: issue.body === "" ? "_No description._" : issue.body,
          },
        ]),
    ...comments.map((comment) => ({
      kind: "comment" as const,
      actor: comment.authorName,
      at: comment.createdAt,
      body: comment.body,
    })),
  ];

  const submit = (): void => {
    if (!issue) return;
    const added = addComment(f.app, f.user, repo, issue, composer.value);
    if (!added.ok) {
      ctx.toast(errorText(added.error), "danger");
      return;
    }
    composer.close();
    reload();
    ctx.toast("comment posted", "success");
  };

  const setState = (state: "open" | "closed"): void => {
    if (!issue) return;
    const changed = setIssueState(f.app, f.user, repo, issue, state);
    if (!changed.ok) ctx.toast(errorText(changed.error), "danger");
    else {
      reload();
      ctx.toast(state === "closed" ? "closed" : "reopened", "success");
    }
  };

  const screen: Screen = {
    title: `#${number}`,
    get keys() {
      return [
        binding(["j", "k"], "scroll"),
        binding(["c"], "comment", { disabled: !f.signedIn }),
        binding(["x"], "close", {
          disabled: !f.signedIn || issue?.state === "closed",
        }),
        binding(["o"], "reopen", {
          disabled: !f.signedIn || issue?.state !== "closed",
        }),
        binding(["l"], "labels", { disabled: !mayWrite() }),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      reload();
      // Live: any event touching this repo invalidates what we are showing.
      const off = f.app.bus.subscribe((event) => {
        if (event.repoId === repo.id) reload();
      });
      signal.addEventListener("abort", off);
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (!issue) return;
      const foot = composer.height();
      // Three rows of head: the title, the summary line, and one blank so the
      // first timeline entry is not glued to the metadata.
      const [head, body, box] = split(area, "v", [
        len(3),
        fill(1),
        len(Math.min(foot, Math.max(0, area.h - 7))),
      ]);
      const right = head!.x + head!.w;
      let x = s.text(
        head!.x,
        head!.y,
        `#${issue.number} `,
        style(c.mutedFg, c.bg),
        right,
      );
      s.text(
        x,
        head!.y,
        truncate(issue.title, Math.max(0, right - x)),
        style(c.fg, c.bg, BOLD),
        right,
      );
      const closed = issue.state !== "open";
      x = dot(s, head!.x, head!.y + 1, c, {
        tone: closed ? "danger" : "success",
      });
      x = s.text(
        x,
        head!.y + 1,
        truncate(
          ` ${issue.state} · opened by ${issue.authorName} ${ago(issue.createdAt)} · ${plural(comments.length, "comment")}`,
          Math.max(0, right - x),
        ),
        style(c.mutedFg, c.bg),
        right,
      );
      for (const label of marks)
        x = labelChip(
          s,
          x + 1,
          head!.y + 1,
          c,
          { text: label.name, color: label.color },
          right,
        );

      if (width !== body!.w) {
        width = body!.w;
        lines = threadLines(entries(), Math.max(20, body!.w - 1), c);
      }
      // An empty conversation says how to start one, where the next entry
      // would have gone — but not while the composer is already open.
      const hint =
        comments.length === 0 && !composer.open
          ? [
              [
                {
                  text: f.signedIn ? "c  comment" : "sign in to comment",
                  style: style(c.faint, c.bg),
                },
              ],
            ]
          : [];
      drawLines(s, body!, c, scroll, [...lines, ...hint]);
      if (foot > 0) composer.render(s, box!, c, ctx);
    },
    paste: (text) => composer.paste(text),
    key(e) {
      if (composer.open) {
        const out = composer.key(e);
        if (out === "submit") submit();
        else if (out === "cancel") composer.close();
        return true;
      }
      if (e.key === "c" && f.signedIn) {
        composer.start("Comment");
        return true;
      }
      if (e.key === "x") {
        setState("closed");
        return true;
      }
      if (e.key === "o") {
        setState("open");
        return true;
      }
      if (e.key === "l" && mayWrite() && issue) {
        const all = listLabels(f.db, repo.id);
        ctx.push(
          pickerScreen(ctx, screen, {
            title: "Labels",
            multi: true,
            items: all.map((l) => ({ id: l.id, label: l.name })),
            chosen: marks.map((l) => l.id),
            onPick: (ids) => {
              if (!issue) return;
              const applied = setIssueLabels(f.app, f.user, repo, issue, ids);
              if (!applied.ok) ctx.toast(errorText(applied.error), "danger");
              else reload();
            },
          }),
        );
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => reload());
        return true;
      }
      return scroll.key(e, lines.length);
    },
  };
  return screen;
}
