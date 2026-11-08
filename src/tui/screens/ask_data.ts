/**
 * The data explorer in the terminal (#9440): the page's `/boards/data` as
 * text. A list of the ready questions, then the sources by their plain names;
 * `enter` opens one as its one-line description and the rows the query
 * returns, and `/` takes a sentence ("memory over the last 3 days") that
 * `parseSentence` reads. A sentence it cannot read goes to the model
 * (`boards/model_fill.ts`), which may only fill the explorer's own fields;
 * with no model it says so and nothing more.
 * The gate is the page's: a site admin who is a person, never an agent; for
 * anyone else the door is not offered, the list is empty and no query runs.
 */

import { ask, GUIDE, parseSentence, QUESTIONS, sentence } from "../../boards/guide.ts";
import { fillFromSentence, MODEL_FILLED, unreadWords } from "../../boards/model_fill.ts";
import { runFor } from "../../boards/panel_data.ts";
import { runQuery } from "../../boards/query.ts";
import { SOURCES } from "../../boards/sources.ts";
import { readParams, toQuery, type Params } from "../../boards/params.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, drawLines, drawList, hitList, hitScroll, promptScreen, Scroll, type ListRow } from "./common.ts";
import { plain } from "./boards.ts";
import type { PaletteEntry } from "./entries.ts";

/** The page's gate: a site admin who is a person. */
export const mayExplore = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

export interface ExploreRow extends ListRow {
  readonly params: Params;
}

const paramsOf = (fill: Record<string, string>): Params => readParams(new URLSearchParams(fill));

/** The ready questions, then each source by its plain name on its default chart; nothing for anyone the gate refuses. */
export function exploreRows(session: Session, now: number): ExploreRow[] {
  if (!mayExplore(session)) return [];
  return [
    ...QUESTIONS.map((q): ExploreRow => ({ title: q.label, secondary: GUIDE[q.source]?.name ?? q.source, params: paramsOf(ask(q, now)) })),
    ...Object.keys(SOURCES).map((s): ExploreRow => ({ title: GUIDE[s]?.name ?? s, secondary: `${s} · ${GUIDE[s]?.rows ?? ""}`, params: paramsOf({ source: s }) })),
  ];
}

/** What a query shows: its sentence, then one line per row; empty for anyone the gate refuses. */
export function resultLines(session: Session, p: Params, note = ""): string[] {
  if (!mayExplore(session)) return [];
  const answer = p.rows === "" ? runFor(session.app.db, p.chart, toQuery(p)) : runQuery(session.app.db, toQuery(p), { repoIds: "all" });
  const lines = [plain(sentence(p)), ...(note === "" ? [] : [note]), ""];
  if (!answer.ok) return [...lines, `refused: ${plain(answer.error)}`];
  if (answer.rows.length === 0) return [...lines, "No rows: nothing matches this query."];
  for (const r of answer.rows) {
    lines.push(`${plain(String(r.group ?? "all"))}${r.series !== undefined ? ` · ${plain(String(r.series ?? "none"))}` : ""}  ${r.value ?? ""}`);
  }
  return lines;
}

export const resultScreen = (ctx: Ctx, session: Session, p: Params, note = ""): Screen => linesScreen(ctx, GUIDE[p.source]?.name ?? "Data", resultLines(session, p, note));

/** Lines of text, scrolled, with `esc` to go back. */
function linesScreen(ctx: Ctx, title: string, lines: string[]): Screen {
  const scroll = new Scroll();
  return {
    title,
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      drawLines(s, area, c, scroll, lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]));
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, lines.length)) return true;
      if (e.key === "esc" || e.key === "q") return ctx.pop(), true;
      return false;
    },
  };
}

export function askDataScreen(session: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: ExploreRow[] = [];
  const open = (p: Params, note = ""): void => ctx.push(resultScreen(ctx, session, p, note));
  const screen: Screen = {
    title: "Data",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["/"], "ask in a sentence")],
    load: async () => {
      rows = exploreRows(session, Date.now());
      state.clamp(rows.length);
    },
    render(area, s) {
      const c = ctx.theme.c;
      s.text(area.x, area.y, truncate("Start from a question, or press / to ask in a sentence.", area.w), style(c.mutedFg, c.bg), area.x + area.w);
      const body = { ...area, y: area.y + 1, h: Math.max(0, area.h - 1) };
      drawList(s, body, c, state, rows);
      hitList(ctx, body, state, rows.length, { open: (i) => rows[i] && open(rows[i]!.params) });
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.key === "enter") {
        const row = rows[state.index];
        if (row) open(row.params);
        return true;
      }
      if (e.key === "/" && mayExplore(session)) {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Ask in a sentence",
            label: "Sentence",
            placeholder: "memory over the last 3 days",
            onSubmit: (text) => {
              if (text.trim() === "") return unreadWords("unread");
              const rules = parseSentence(text, Date.now());
              // The rules answer first, free, with the prompt closing after this returns.
              if (rules) return Promise.resolve().then(() => open(paramsOf(rules)));
              // A miss asks the model, on the asker's own budget; the result says it did.
              return fillFromSentence(session.app, session.user!.id, text, Date.now()).then((r) => {
                if (r.ok) return open(paramsOf(r.fill), r.by === "model" ? MODEL_FILLED : "");
                // The prompt has closed by now; the reason shows as a toast, not a screen.
                ctx.toast(unreadWords(r.why), "danger");
              });
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** The explorer, as the page gates it: a site admin who is a person, never an agent. */
export const entry: PaletteEntry = {
  id: "ask-data",
  title: "Data explorer",
  hint: "start from a question about the forge's data",
  after: ["boards"],
  offered: mayExplore,
  run: (session, ctx) => ctx.push(askDataScreen(session, ctx)),
};
