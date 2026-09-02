/**
 * Opening a pull request. The base defaults to the fork parent when there is
 * one, because that is what a fork is for; everything else is two ref pickers
 * and a title.
 */

import { openPull } from "../../actions/pulls.ts";
import { getRepoById, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { Textarea } from "../ui/textarea.ts";
import { card, field } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { errorText, runAsync } from "./common.ts";
import { pullScreen } from "./pull.ts";
import { refPickerScreen } from "./refs.ts";
import { local } from "./where.ts";

type Focus = 0 | 1 | 2 | 3 | 4;

export function newPullScreen(f: Session, ctx: Ctx, head: Repo): Screen {
  const parent =
    head.forkParentId === null
      ? undefined
      : getRepoById(f.db, head.forkParentId);
  let base: Repo = parent ?? head;
  let baseBranch = base.defaultBranch;
  let headBranch = head.defaultBranch;
  let title = "";
  const body = new Textarea("");
  let focus: Focus = 0;
  let error: string | undefined;

  const submit = (): void => {
    runAsync(ctx, async () => {
      const created = await openPull(f.app, f.user, base, {
        title,
        body: body.value,
        baseBranch,
        headBranch,
        ...(base.id === head.id ? {} : { headRepo: head }),
      });
      if (!created.ok) {
        error = errorText(String(created.error));
        ctx.toast(error, "danger");
        return;
      }
      ctx.toast(`opened #${created.value.number}`, "success");
      ctx.replace(pullScreen(f, ctx, local(f, base), created.value.number));
    });
  };

  const screen: Screen = {
    title: "New pull request",
    keys: [
      binding(["tab"], "next field"),
      binding(["enter"], "pick"),
      binding(["ctrl+d"], "open pull"),
      binding(["esc"], "discard"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [rows, titleRow, rest] = split(area, "v", [
        len(4),
        len(4),
        fill(1),
      ]);
      const lines: [string, string][] = [
        ["Base repo", `${base.ownerName}/${base.name}`],
        ["Base branch", baseBranch],
        ["Head branch", `${head.ownerName}/${head.name}:${headBranch}`],
      ];
      lines.forEach(([label, value], i) => {
        const selected = focus === i;
        s.text(
          rows!.x,
          rows!.y + i,
          truncate(label, 14),
          style(c.mutedFg, c.bg),
          rows!.x + rows!.w,
        );
        s.text(
          rows!.x + 15,
          rows!.y + i,
          truncate(value, Math.max(0, rows!.w - 15)),
          style(selected ? c.accent : c.fg, c.bg, selected ? 1 : 0),
          rows!.x + rows!.w,
        );
      });
      const cursor = field(s, titleRow!, c, {
        label: "Title",
        value: title,
        focused: focus === 3,
        ...(focus === 3 ? { cursor: [...title].length } : {}),
        ...(error === undefined ? {} : { error }),
      });
      const inner = card(s, rest!, c, {
        title: "Description",
        footer: "ctrl+d submit",
        focused: focus === 4,
      });
      const bodyCursor = body.render(s, inner, c, focus === 4);
      ctx.setCursor(focus === 3 ? cursor : focus === 4 ? bodyCursor : null);
    },
    paste(text) {
      if (focus === 4) body.paste(text);
      else if (focus === 3) title += text.replace(/\s+/g, " ");
      return true;
    },
    key(e) {
      if (e.ctrl && e.key === "d") {
        submit();
        return true;
      }
      if (e.key === "tab") {
        focus = ((focus + 1) % 5) as Focus;
        return true;
      }
      if (focus === 4) {
        const out = body.key(e);
        if (out === "submit") {
          submit();
          return true;
        }
        return out !== "ignored" && out !== "cancel";
      }
      if (focus === 3) {
        if (e.key === "backspace") {
          title = [...title].slice(0, -1).join("");
          return true;
        }
        if (!e.ctrl && !e.alt && [...e.key].length === 1) {
          title += e.key;
          error = undefined;
          return true;
        }
        return false;
      }
      if (e.key === "j" || e.key === "down") {
        focus = Math.min(4, focus + 1) as Focus;
        return true;
      }
      if (e.key === "k" || e.key === "up") {
        focus = Math.max(0, focus - 1) as Focus;
        return true;
      }
      if (e.key === "enter") {
        if (focus === 0 && parent) {
          base = base.id === head.id ? parent : head;
          baseBranch = base.defaultBranch;
          return true;
        }
        if (focus === 1)
          ctx.push(
            refPickerScreen(
              f,
              ctx,
              screen,
              local(f, base),
              (chosen) => {
                baseBranch = chosen;
              },
              { branchesOnly: true, title: "Base branch" },
            ),
          );
        if (focus === 2)
          ctx.push(
            refPickerScreen(
              f,
              ctx,
              screen,
              local(f, head),
              (chosen) => {
                headBranch = chosen;
              },
              { branchesOnly: true, title: "Head branch" },
            ),
          );
        return true;
      }
      return false;
    },
  };
  return screen;
}
