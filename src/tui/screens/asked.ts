/**
 * `/asked` in the terminal (#1755): the owner's thoughts, then what they
 * asked for in issues, from the same `thoughtStream` and `askedIn` reads the
 * page makes — so the gate is core's and not this screen's. A guest has
 * neither, a viewer sees only their own thoughts, and a placement in a
 * repository the viewer cannot read says so and names nothing of it.
 * The palette offers the door only when signed in, so the screen has no
 * signed-out face; `askedLines` still returns nothing for a guest. Read-only; `enter` on an ask hands over its web address.
 */

import type { Database } from "bun:sqlite";
import { askedIn, askedRepos, type Asked } from "../../core/asked.ts";
import { thoughtStream, type StreamThought } from "../../core/thought_stream.ts";
import type { User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { split, fill, len } from "../ui/layout.ts";
import { emptyState, type Tone } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, drawList, hitList, metaOf, openOnWeb, relTime, type ListRow } from "./common.ts";

/** One line of plain text: a typed thought may carry newlines or escapes the terminal must not obey. */
const plain = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

export interface AskedLine extends ListRow {
  /** The web path `enter` opens; absent for a thought. */
  readonly path?: string;
}

const THOUGHT_WORD = {
  unplaced: "heard",
  placed: "placed",
  building: "building",
  shipped: "shipped",
  superseded: "superseded",
} as const;

/** Red is for nothing built, green for shipped, amber for under way. */
function toneOf(flagged: boolean, state: string): { tone?: Tone } {
  if (flagged) return { tone: "danger" };
  if (state === "shipped") return { tone: "success" };
  return state === "building" ? { tone: "attn" } : {};
}

function thoughtLine(t: StreamThought): AskedLine {
  const where = t.placed.map((x) =>
    x.readable ? `${x.action} ${x.repo} #${x.number}` : `${x.action} in a repository you cannot read`,
  );
  return {
    title: plain(t.text),
    ...toneOf(t.flagged, t.state),
    hollow: t.state === "unplaced" || t.state === "superseded",
    secondary: plain(where.length > 0 ? where.join(" · ") : (t.reply ?? "the planner has not placed it yet")),
    meta: metaOf(t.flagged ? "nothing built" : THOUGHT_WORD[t.state], relTime(t.receivedAt)),
  };
}

function askLine(a: Asked): AskedLine {
  const word =
    a.doneBy.length > 0 ? "done on main" : a.flagged ? "nothing built" : a.state;
  return {
    title: plain(a.issue.title),
    ...toneOf(a.flagged, a.state),
    secondary: `${a.repo.ownerName}/${a.repo.name} #${a.issue.number} · ${plain(a.askedBy)}`,
    meta: metaOf(word, relTime(a.askedAt)),
    path: `/${a.repo.ownerName}/${a.repo.name}/issues/${a.issue.number}`,
  };
}

/** The thoughts, then the asks, as rows. A guest has none of either. */
export function askedLines(db: Database, viewer: User | undefined): { thoughts: AskedLine[]; asks: AskedLine[] } {
  if (viewer === undefined) return { thoughts: [], asks: [] };
  const repos = askedRepos(db, viewer, null);
  return {
    thoughts: thoughtStream(db, viewer, { limit: 50 }).map(thoughtLine),
    asks: askedIn(db, repos, { show: "unshipped", order: "oldest" }).map(askLine),
  };
}

export function askedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let lines: AskedLine[] = [];
  let thoughtCount = 0;
  const open = (index: number): void => {
    const line = lines[index];
    if (line?.path !== undefined) openOnWeb(f, ctx, line.path, "That ask");
  };
  const read = (): void => {
    const got = askedLines(f.db, f.user);
    lines = [...got.thoughts, ...got.asks];
    thoughtCount = got.thoughts.length;
    state.clamp(lines.length);
  };
  return {
    title: "Asked",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["r"], "refresh")],
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const sentence = `${thoughtCount} thoughts · ${lines.length - thoughtCount} asks not shipped`;
      s.text(head!.x, head!.y, truncate(sentence, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (lines.length === 0) {
        emptyState(s, body!, c, {
          title: "Nothing asked yet",
          body: "What you tell the crew shows up here, with what became of it.",
        });
        return;
      }
      drawList(s, body!, c, state, lines);
      hitList(ctx, body!, state, lines.length, { open });
    },
    key(e) {
      if (state.key(e, lines.length)) return true;
      if (e.key === "enter") {
        open(state.index);
        return true;
      }
      if (e.key === "r") {
        read();
        ctx.invalidate();
        return true;
      }
      return false;
    },
  };
}
