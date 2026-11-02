/**
 * "New organization" in the terminal (#7260): one field, a name, through
 * `createOrg` as the page and MCP `org_create` call it, so every rule
 * (taken, reserved, invalid, an agent cannot own one) is the action's and
 * the refusal is `createOrgWords`. A refused name stays in the field to fix.
 * Once made, the screen says where the organization lives, and **n** opens
 * the new-repository screen with it as the owner.
 */

import { createOrg, createOrgWords } from "../../actions/orgs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { field } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { newRepoScreen } from "./newrepo.ts";

export function newOrgScreen(f: Session, ctx: Ctx): Screen {
  let name = "";
  let error: string | undefined;
  let made: string | undefined;

  const where = (org: string): string => {
    const base = f.app.config.url;
    return base === undefined ? `/${org}` : `${base.replace(/\/+$/, "")}/${org}`;
  };

  const submit = (): void => {
    const created = createOrg(f.app, f.user, name.trim());
    if (!created.ok) {
      error = createOrgWords(created.error);
      ctx.toast(error, "danger");
      return;
    }
    made = created.value.username;
    ctx.toast(`Created ${made}.`, "success");
  };

  return {
    title: "New organization",
    get keys() {
      return made === undefined
        ? [binding(["enter"], "create"), binding(["esc"], "discard")]
        : [binding(["n"], "new repository under it"), binding(["esc"], "close")];
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (made !== undefined) {
        ctx.setCursor(null);
        const lines = [
          `Made ${made}. You are its first owner.`,
          `It lives at ${where(made)}.`,
          "",
          `n opens a new repository under ${made}.`,
        ];
        lines.forEach((line, i) =>
          s.text(area.x, area.y + i, truncate(line, area.w), style(i < 2 ? c.fg : c.mutedFg, c.bg), area.x + area.w),
        );
        return;
      }
      const cursor = field(s, { x: area.x, y: area.y, w: Math.min(60, area.w), h: 3 }, c, {
        label: "Name",
        value: name,
        cursor: [...name].length,
        focused: true,
        ...(error === undefined
          ? { hint: "Letters, digits, dots and dashes. You will be its first owner." }
          : { error }),
      });
      ctx.setCursor(cursor);
    },
    paste(text) {
      if (made !== undefined) return false;
      name += text.replace(/\s+/g, "");
      error = undefined;
      return true;
    },
    key(e) {
      if (made !== undefined) {
        if (e.key !== "n" || e.ctrl || e.alt) return false;
        ctx.replace(newRepoScreen(f, ctx, made));
        return true;
      }
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
