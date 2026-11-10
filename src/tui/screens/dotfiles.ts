/**
 * Your dotfiles repository, in the terminal: the repository whose top-level
 * dotfiles every shell you open gets, with `e` to name one and `x` to clear
 * it, through `setDotfilesRepo` — the call behind Settings › Shells, refusing
 * in the same words.
 */

import { DOTFILES_ERRORS, dotfilesRepoOf, setDotfilesRepo } from "../../machines/dotfiles.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function dotfilesScreen(f: Session, ctx: Ctx): Screen {
  const save = (text: string): string | undefined => {
    if (f.user === undefined) return undefined;
    const r = setDotfilesRepo(f.app.db, f.user, text);
    if (!r.ok) {
      const words = DOTFILES_ERRORS[r.error];
      ctx.toast(words, "danger");
      return words;
    }
    ctx.toast(r.value === "set" ? "Dotfiles repository saved." : "Dotfiles repository cleared.", "success");
    ctx.invalidate();
    return undefined;
  };

  const screen: Screen = {
    title: "Your dotfiles",
    keys: [binding(["e"], "set repository"), binding(["x"], "clear")],
    render(area, s) {
      const c = ctx.theme.c;
      if (f.user === undefined) return;
      const named = dotfilesRepoOf(f.app.db, f.user.id);
      s.text(area.x, area.y, "Repository".padEnd(14), style(c.mutedFg, c.bg), area.x + area.w);
      s.text(area.x + 14, area.y, truncate(named ?? "none", Math.max(0, area.w - 14)), style(c.fg, c.bg), area.x + area.w);
    },
    key(e) {
      if (e.ctrl || e.alt || f.user === undefined) return false;
      if (e.key === "e") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Dotfiles repository",
            label: "owner/name",
            value: dotfilesRepoOf(f.app.db, f.user.id) ?? "",
            onSubmit: save,
          }),
        );
        return true;
      }
      if (e.key === "x") {
        save("");
        return true;
      }
      return false;
    },
  };
  return screen;
}

export const entry: PaletteEntry = {
  id: "dotfiles",
  title: "Your dotfiles",
  hint: "the repository every shell you open copies from",
  offered: (session) => session.user !== undefined && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(dotfilesScreen(session, ctx)),
};
