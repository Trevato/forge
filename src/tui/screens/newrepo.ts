/**
 * Creating a repository, and forking one. Both land on the new repo's home,
 * because the next thing anyone does is look at it.
 */

import { GUEST_REFUSALS, isGuestRefusal } from "../../core/contribute.ts";
import { storageLimitMessage } from "../../core/storage.ts";
import { createRepo, forkRepo, repositoryLimitMessage, resolveOwner } from "../../actions/repos.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { field } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { errorText, runAsync } from "./common.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";

type Focus = 0 | 1 | 2 | 3;

export function newRepoScreen(f: Session, ctx: Ctx, owner?: string): Screen {
  const owners = f.user
    ? [
        f.user.username,
        ...listOrgsForUser(f.db, f.user.id).map((o) => o.username),
      ]
    : [];
  let ownerIndex = Math.max(0, owners.indexOf(owner ?? owners[0] ?? ""));
  let name = "";
  let description = "";
  let visibility: "public" | "private" = "private";
  let focus: Focus = 0;
  let error: string | undefined;

  const submit = (): void => {
    runAsync(ctx, async () => {
      const ownerName = owners[ownerIndex] ?? "";
      const created = await createRepo(f.app, f.user, {
        owner: ownerName,
        name,
        description,
        visibility,
      });
      if (!created.ok) {
        error =
          created.error === "storage_limit"
            ? `not made: ${storageLimitMessage(f.app, resolveOwner(f.app, f.user!, ownerName) ?? f.user!.id)}`
            : created.error === "repository_limit"
            ? `not made: ${repositoryLimitMessage(f.app, f.user!)}`
            : errorText(created.error);
        ctx.toast(error, "danger");
        return;
      }
      ctx.toast(`created ${created.value.name}`, "success");
      ctx.replace(repoScreen(f, ctx, local(f, created.value)));
    });
  };

  return {
    title: "New repository",
    keys: [
      binding(["tab"], "next field"),
      binding(["space"], "toggle"),
      binding(["ctrl+d"], "create repo"),
      binding(["esc"], "discard"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [top, rest] = split(area, "v", [len(8), fill(1)]);
      const nameCursor = field(
        s,
        { x: top!.x, y: top!.y, w: top!.w, h: 3 },
        c,
        {
          label: `Name (under ${owners[ownerIndex] ?? "?"})`,
          value: name,
          focused: focus === 0,
          ...(focus === 0 ? { cursor: [...name].length } : {}),
          ...(error === undefined
            ? { hint: "Letters, digits, dot, dash, underscore." }
            : { error }),
        },
      );
      const descCursor = field(
        s,
        { x: top!.x, y: top!.y + 4, w: top!.w, h: 3 },
        c,
        {
          label: "Description",
          value: description,
          focused: focus === 1,
          ...(focus === 1 ? { cursor: [...description].length } : {}),
        },
      );
      ctx.setCursor(focus === 0 ? nameCursor : focus === 1 ? descCursor : null);
      s.text(
        rest!.x,
        rest!.y,
        truncate(`owner    ${owners[ownerIndex] ?? "?"}`, rest!.w),
        style(focus === 2 ? c.accent : c.mutedFg, c.bg),
        rest!.x + rest!.w,
      );
      s.text(
        rest!.x,
        rest!.y + 1,
        truncate(`visibility  ${visibility}`, rest!.w),
        style(focus === 3 ? c.accent : c.mutedFg, c.bg),
        rest!.x + rest!.w,
      );
    },
    paste(text) {
      const clean = text.replace(/\s+/g, " ");
      if (focus === 0) name += clean.trim();
      if (focus === 1) description += clean;
      return true;
    },
    key(e) {
      if (e.ctrl && e.key === "d") {
        submit();
        return true;
      }
      if (e.key === "tab") {
        focus = ((focus + 1) % 4) as Focus;
        return true;
      }
      if (focus === 2 && (e.key === " " || e.key === "enter")) {
        ownerIndex = owners.length === 0 ? 0 : (ownerIndex + 1) % owners.length;
        return true;
      }
      if (focus === 3 && (e.key === " " || e.key === "enter")) {
        visibility = visibility === "private" ? "public" : "private";
        return true;
      }
      if (e.key === "enter") {
        submit();
        return true;
      }
      if (e.key === "backspace") {
        if (focus === 0) name = [...name].slice(0, -1).join("");
        if (focus === 1) description = [...description].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        if (focus === 0) name += e.key;
        if (focus === 1) description += e.key;
        error = undefined;
        return focus < 2;
      }
      return false;
    },
  };
}

export function forkScreen(f: Session, ctx: Ctx, parent: Repo): Screen {
  let name = parent.name;
  let error: string | undefined;
  const submit = (): void => {
    runAsync(ctx, async () => {
      const forked = await forkRepo(f.app, f.user, parent, name);
      if (!forked.ok) {
        error =
          forked.error === "storage_limit"
            ? `not made: ${storageLimitMessage(f.app, f.user!.id)}`
            : forked.error === "repository_limit"
            ? `not made: ${repositoryLimitMessage(f.app, f.user!)}`
            : isGuestRefusal(forked.error)
            ? GUEST_REFUSALS[forked.error]
            : errorText(forked.error);
        ctx.toast(error, "danger");
        return;
      }
      ctx.toast(`forked to ${forked.value.ownerName}/${name}`, "success");
      ctx.replace(repoScreen(f, ctx, local(f, forked.value)));
    });
  };
  return {
    title: "Fork",
    keys: [binding(["enter"], "fork"), binding(["esc"], "cancel")],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(
        area.x,
        area.y,
        truncate(
          `Fork ${parent.ownerName}/${parent.name} into ${f.user?.username ?? "?"}`,
          area.w,
        ),
        style(c.fg, c.bg),
        area.x + area.w,
      );
      const cursor = field(
        s,
        { x: area.x, y: area.y + 2, w: Math.min(60, area.w), h: 3 },
        c,
        {
          label: "Name",
          value: name,
          cursor: [...name].length,
          focused: true,
          ...(error === undefined
            ? {
                hint: "Objects are shared with the parent — forking is instant.",
              }
            : { error }),
        },
      );
      ctx.setCursor(cursor);
    },
    key(e) {
      if (e.key === "enter") {
        submit();
        return true;
      }
      if (e.key === "backspace") {
        name = [...name].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        name += e.key;
        error = undefined;
        return true;
      }
      return false;
    },
  };
}
