/**
 * One issue: the conversation, the composer, and the state and label changes
 * a participant is allowed to make.
 *
 * The conversation comes from the `RepoSource`, so the same screen reads an
 * issue we hold and one on another forge — and the composer and the state
 * keys simply do not exist on the second, because `capabilities.write` is
 * false and there is no method on that source that could write anyway.
 *
 * On a repository we hold it subscribes to the event bus while it is on the
 * stack, so a comment posted from the web (or by another terminal) appears
 * without a keypress. The subscription is released by the screen's own abort
 * signal — popping the screen is what unsubscribes it, with no lifecycle
 * hook needed.
 */

import {
  addCommentThrough,
  setIssueLabelsThrough,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { getIssue, type Label } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import type { IssueDetail, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { dot, labelChip } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ORIGIN_MARK,
  Scroll,
  ago,
  drawLines,
  errorText,
  pickerScreen,
  plural,
  runAsync,
} from "./common.ts";
import { liveBindings, liveKey } from "./mirror.ts";
import { Composer, threadLines, type ThreadEntry } from "./thread.ts";
import { local, localRepo, whereRows, whereStrip } from "./where.ts";

export function issueScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  number: number,
  keep: { top?: number } = {},
): Screen {
  let detail: IssueDetail | undefined;
  let labels: Label[] = [];
  let lines: Span[][] = [];
  let width = 0;
  const scroll = new Scroll();
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
    width = 0;
    ctx.invalidate();
    const listed = await src.labels();
    labels = listed.ok ? listed.value : [];
  };

  /** The core row a write needs. Only ever reached on a local source. */
  const row = ():
    | { repo: Repo; issue: ReturnType<typeof getIssue> }
    | undefined =>
    repo === undefined
      ? undefined
      : { repo, issue: getIssue(f.db, repo.id, number) };

  // An imported author is the login on the *origin*, so it is shown in place
  // of the local one and marked with the upstream glyph — a name from another
  // forge must never be mistaken for an account here.
  const who = (name: string, origin: string | null): string =>
    origin === null || origin === "" ? name : `${ORIGIN_MARK} ${origin}`;

  const entries = (): ThreadEntry[] =>
    detail === undefined
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
          ...detail.comments.map((comment) => ({
            kind: "comment" as const,
            actor: who(comment.authorName, comment.originAuthor),
            at: comment.createdAt,
            body: comment.body,
          })),
        ];

  // The `…Through` twins: identical on a native repo, and on a mirror they
  // write to the origin first and reflect what came back.
  const submit = (): void => {
    const at = row();
    if (at?.issue === undefined) return;
    const { repo: target, issue } = at;
    const body = composer.value;
    runAsync(ctx, async () => {
      const added = await addCommentThrough(f.app, f.user, target, issue, body);
      if (!added.ok) {
        ctx.toast(errorText(added.error), "danger");
        return;
      }
      composer.close();
      await reload();
      ctx.toast("comment posted", "success");
    });
  };

  const setState = (state: "open" | "closed"): void => {
    const at = row();
    if (at?.issue === undefined) return;
    const { repo: target, issue } = at;
    runAsync(ctx, async () => {
      const changed = await setIssueStateThrough(
        f.app,
        f.user,
        target,
        issue,
        state,
      );
      if (!changed.ok) ctx.toast(errorText(changed.error), "danger");
      else {
        await reload();
        ctx.toast(state === "closed" ? "closed" : "reopened", "success");
      }
    });
  };

  const screen: Screen = {
    title: `#${number}`,
    get keys() {
      return [
        binding(["j", "k"], "scroll"),
        ...(mayWrite()
          ? [
              binding(["c"], "comment"),
              binding(["x"], "close", {
                disabled: detail?.issue.state === "closed",
              }),
              binding(["o"], "reopen", {
                disabled: detail?.issue.state !== "closed",
              }),
              binding(["l"], "labels"),
            ]
          : liveBindings(src)),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      // Live: any event touching this repo invalidates what we are showing.
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
      // The where-strip, then three rows of head: the title, the summary
      // line, and one blank so the first entry is not glued to the metadata.
      const [strip, head, body, box] = split(area, "v", [
        len(whereRows(src)),
        len(3),
        fill(1),
        len(Math.min(foot, Math.max(0, area.h - 7 - whereRows(src)))),
      ]);
      whereStrip(s, strip!, c, f, src);
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
          ` ${issue.state} · opened by ${who(issue.authorName, issue.originAuthor)} ${ago(issue.createdAt)} · ${plural(detail.comments.length, "comment")}`,
          Math.max(0, right - x),
        ),
        style(c.mutedFg, c.bg),
        right,
      );
      for (const label of issue.labels)
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
        detail.comments.length === 0 && !composer.open
          ? [
              [
                {
                  text: mayWrite()
                    ? "c  comment"
                    : src.capabilities.mirror
                      ? "read-only · m mirrors this repository into your workbench"
                      : "sign in to comment",
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
      if (e.key === "c" && mayWrite()) {
        composer.start("Comment");
        return true;
      }
      if (e.key === "x" && mayWrite()) {
        setState("closed");
        return true;
      }
      if (e.key === "o" && mayWrite()) {
        setState("open");
        return true;
      }
      if (e.key === "l" && mayWrite()) {
        const at = row();
        if (at?.issue === undefined) return true;
        const { repo: target, issue } = at;
        ctx.push(
          pickerScreen(ctx, screen, {
            title: "Labels",
            multi: true,
            items: labels.map((l) => ({ id: l.id, label: l.name })),
            chosen: (detail?.issue.labels ?? []).map((l) => l.id),
            onPick: (ids) => {
              runAsync(ctx, async () => {
                const applied = await setIssueLabelsThrough(
                  f.app,
                  f.user,
                  target,
                  issue,
                  ids,
                );
                if (!applied.ok) ctx.toast(errorText(applied.error), "danger");
                else await reload();
              });
            },
          }),
        );
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }
      if (
        liveKey(f, ctx, e, src, {
          parent: screen,
          onDone: (next) =>
            ctx.replace(
              issueScreen(f, ctx, local(f, next), number, { top: scroll.top }),
            ),
        })
      )
        return true;
      return scroll.key(e, lines.length);
    },
  };
  return screen;
}
