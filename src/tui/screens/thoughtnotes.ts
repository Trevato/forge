/**
 * /notes in the terminal (#8696): the same door as the page. `n` writes a
 * note (`keepThought`, the one door the page, the composer and the MCP use),
 * the list is the signed-in person's own `thoughtStream` with `noteLine`'s
 * one-line state, and `b` takes the tap the line offers (`overruleNote`, which
 * refuses what the line does not offer). Everything is the person's own: a
 * guest has nothing, and the palette offers the screen only when signed in.
 * A note written here shows live on the page, being the same row.
 */

import { overruleNote } from "../../actions/note_overrule.ts";
import { keepThought, THOUGHT_MAX } from "../../actions/thought.ts";
import { noteLine, type NotePhase } from "../../core/note_line.ts";
import { thoughtStream } from "../../core/thought_stream.ts";
import type { User } from "../../core/users.ts";
import type { Database } from "bun:sqlite";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { split, fill, len } from "../ui/layout.ts";
import { emptyState, input, type Tone } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, drawList, hitList, metaOf, relTime, type ListRow } from "./common.ts";

const SHOWN = 50;

/** One line of plain text: a typed note may carry newlines or escapes the terminal must not obey. */
const plain = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

const TONE: Partial<Record<NotePhase, Tone>> = { building: "attn", review: "attn", shipped: "success" };

export interface NoteRow extends ListRow {
  readonly id: string;
  /** The tap the line offers, if any. */
  readonly overrule: "build" | "decline" | null;
}

/** The viewer's notes as rows; a guest has none. */
export function noteRows(db: Database, viewer: User | undefined): NoteRow[] {
  if (viewer === undefined) return [];
  return thoughtStream(db, viewer, { limit: SHOWN }).map((n) => {
    const line = noteLine(n);
    const tone = TONE[line.phase];
    return {
      id: n.id,
      title: plain(n.text),
      ...(tone ? { tone } : {}),
      hollow: line.phase === "waiting" || line.phase === "superseded",
      secondary: plain(line.text + (line.links.length > 0 ? ` · ${line.links.map((l) => l.label).join(" ")}` : "") + (line.overrule ? ` · b: ${line.overrule.label}` : "")),
      meta: metaOf(line.phase, relTime(n.receivedAt)),
      overrule: line.overrule?.do ?? null,
    };
  });
}

export function notesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: NoteRow[] = [];
  let typing = false;
  let draft = "";
  const read = (): void => {
    rows = noteRows(f.db, f.user);
    state.clamp(rows.length);
  };
  const save = (): void => {
    if (f.user === undefined || draft.trim() === "") return;
    const kept = keepThought(f.app, f.user, draft, "composer");
    if (!kept.ok) {
      ctx.toast(`A note is at most ${THOUGHT_MAX} characters`, "attn");
      return;
    }
    draft = "";
    typing = false;
    read();
    state.index = 0;
    state.offset = 0;
    ctx.toast("Saved. The planner will pick it up.", "success");
  };
  const overrule = (): void => {
    const row = rows[state.index];
    if (row === undefined || row.overrule === null) return;
    const done = overruleNote(f.app, f.user, row.id, row.overrule);
    ctx.toast(done.ok ? (done.value === "accepted" ? "Built after all" : "Declined") : "That note cannot be changed now", done.ok ? "success" : "attn");
    read();
  };
  return {
    title: "Notes",
    get keys() {
      return typing
      ? [binding(["enter"], "save"), binding(["esc"], "cancel")]
      : [binding(["j", "k"], "move"), binding(["n"], "write a note"), binding(["b"], "overrule the planner"), binding(["r"], "refresh")];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(typing ? 2 : 1), fill(1)]);
      if (typing) {
        input(s, { ...head!, y: head!.y }, c, { value: draft, placeholder: "Write an idea. Enter saves it.", focused: true, cursor: [...draft].length });
      } else s.text(head!.x, head!.y, truncate(`${rows.length} notes · n writes one`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (rows.length === 0) {
        emptyState(s, body!, c, { title: "No notes yet", body: "Press n and write an idea. The crew plans it and this page says where it is." });
        return;
      }
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, {});
    },
    key(e) {
      if (typing) {
        if (e.key === "enter") save();
        else if (e.key === "esc") typing = false;
        else if (e.key === "backspace") draft = [...draft].slice(0, -1).join("");
        else if (!e.ctrl && !e.alt && [...e.key].length === 1) draft += e.key;
        ctx.invalidate();
        return true;
      }
      if (state.key(e, rows.length)) return true;
      if (e.key === "n") typing = true;
      else if (e.key === "b") overrule();
      else if (e.key === "r") read();
      else return false;
      ctx.invalidate();
      return true;
    },
    paste(text) {
      if (!typing) return false;
      draft += plain(text);
      ctx.invalidate();
      return true;
    },
  };
}
