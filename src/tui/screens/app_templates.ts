/**
 * App templates in the terminal, a forge admin's: the repositories New app
 * offers, default first, as Settings → App templates lists them. `m` asks for
 * an `owner/name` and marks it; `u` unmarks the one under the cursor after a
 * confirm. Both go through `markTemplate`, so the refusals are the page's and
 * the API's words. Anyone who is not an admin (or is an agent) is offered no
 * entry and marks nothing.
 */

import { MARK_TEMPLATE_ERRORS, markTemplate } from "../../actions/app_templates.ts";
import { DEFAULT_TEMPLATE, markedTemplates } from "../../core/app_templates.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { PaletteEntry } from "./entries.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, promptScreen, type ListRow } from "./common.ts";

const mayMark = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind === "user";

export function appTemplatesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: { name: string; visibility: string }[] = [];
  let note = "";
  const reload = (): void => {
    rows = mayMark(f)
      ? markedTemplates(f.db).map((r) => ({ name: `${r.ownerName}/${r.name}`, visibility: r.visibility }))
      : [];
    state.clamp(rows.length);
    ctx.invalidate();
  };
  reload();
  const change = (named: string, marked: boolean): string | undefined => {
    const done = markTemplate(f.app, f.user, named, marked);
    note = done.ok ? `${done.value.name} is ${marked ? "marked" : "unmarked"}.` : MARK_TEMPLATE_ERRORS[done.error];
    reload();
    return done.ok ? undefined : note;
  };

  const mark = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Mark a template",
      label: "Which repository?",
      placeholder: "owner/name",
      onSubmit: (named) => change(named.trim(), true),
    });
  const unmark = (name: string): Screen =>
    confirmScreen(ctx, screen, {
      title: "Unmark this template",
      body: [name, "New app stops offering it."],
      actions: [{ label: "Keep", variant: "ghost" }, { label: "Unmark", variant: "danger" }],
      onChoose: (i) => {
        if (i === 1) change(name, false);
      },
    });

  const lines = (): ListRow[] =>
    rows.map((r) => ({
      title: r.name,
      meta: r.name === DEFAULT_TEMPLATE ? "always offered, first" : r.visibility === "private" ? "private" : "",
    }));

  const screen: Screen = {
    title: "App templates",
    keys: [binding(["m"], "mark one"), binding(["u"], "unmark"), binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const text = note !== "" ? note : mayMark(f) ? `${rows.length} offered by New app.` : MARK_TEMPLATE_ERRORS.forbidden;
      const said = wrap(text, Math.max(1, area.w)).slice(0, 3);
      const [head, list] = split(area, "v", [len(said.length), fill(1)]);
      said.forEach((line, i) => s.text(head!.x, head!.y + i, line, style(c.mutedFg, c.bg), head!.x + head!.w));
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || !mayMark(f)) return false;
      if (e.key === "m") {
        note = "";
        ctx.push(mark());
        return true;
      }
      const r = rows[state.index];
      if (e.key === "u" && r !== undefined) {
        note = "";
        ctx.push(unmark(r.name));
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** Offered to a forge admin who is not an agent. */
export const entry: PaletteEntry = {
  id: "app-templates",
  title: "App templates",
  hint: "the repositories New app offers; mark or unmark one",
  after: ["economics"],
  offered: (session) => mayMark(session),
  run: (session, ctx) => ctx.push(appTemplatesScreen(session, ctx)),
};
