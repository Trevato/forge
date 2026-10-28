/**
 * `/asked` in the terminal (#1755): the owner's thoughts, then what they
 * asked for in issues, from the same `thoughtStream` and `askedIn` reads the
 * page makes — so the gate is core's and not this screen's. A guest has
 * neither, a viewer sees only their own thoughts, and a placement in a
 * repository the viewer cannot read says so and names nothing of it.
 * The palette offers the door only when signed in, so the screen has no
 * signed-out face; `askedLines` still returns nothing for a guest. Read-only; `enter` on an ask hands over its web address.
 * `s` cycles unshipped → flagged → all and `o` flips oldest/newest, with MCP
 * `asked`'s defaults, words and order (#7303) — not the page's grouping.
 */

import type { Database } from "bun:sqlite";
import { thoughtNotes, whereItWent } from "../../actions/ask_state_words.ts";
import { askedIn, askedRepos, outcomeText, type Asked, type AskedOrder, type AskedShow } from "../../core/asked.ts";
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

/** Where it went and what it repeats or takes back, in /asked's words (`whereItWent`, `thoughtNotes`). */
function thoughtLine(t: StreamThought): AskedLine {
  const where = whereItWent(t).map((x) => `${x.lead}${x.text}`);
  const notes = thoughtNotes(t).map((n) => `${n.text} ${relTime(n.at)}`);
  return {
    title: plain(t.text),
    ...toneOf(t.flagged, t.state),
    hollow: t.state === "unplaced" || t.state === "superseded",
    secondary: plain([...where, ...notes].join(" · ")),
    meta: metaOf(t.flagged ? "nothing built" : THOUGHT_WORD[t.state], relTime(t.receivedAt)),
  };
}

/** The state, then stale or flagged, in MCP `asked`'s words; the outcome is the secondary line. */
function askLine(a: Asked): AskedLine {
  return {
    title: plain(a.issue.title),
    ...toneOf(a.flagged, a.state),
    secondary: `${plain(outcomeText(a))} · ${a.repo.ownerName}/${a.repo.name} #${a.issue.number}`,
    meta: metaOf(a.state, a.flagged ? "flagged" : a.stale ? "stale" : "", relTime(a.askedAt)),
    path: `/${a.repo.ownerName}/${a.repo.name}/issues/${a.issue.number}`,
  };
}

/** What MCP `asked` takes, and its defaults. */
export interface AskedView {
  readonly show: AskedShow;
  readonly order: AskedOrder;
}

export const DEFAULT_VIEW: AskedView = { show: "unshipped", order: "oldest" };

const SHOW_CYCLE: readonly AskedShow[] = ["unshipped", "flagged", "all"];

const SHOW_WORDS: Record<AskedShow, string> = { unshipped: "not shipped", flagged: "flagged", all: "all" };

/** The choice in words, for the title: "not shipped, oldest first". */
export const viewWords = (v: AskedView): string => `${SHOW_WORDS[v.show]}, ${v.order} first`;

export const nextShow = (show: AskedShow): AskedShow =>
  SHOW_CYCLE[(SHOW_CYCLE.indexOf(show) + 1) % SHOW_CYCLE.length]!;

/** The thoughts, then the asks, as rows. A guest has none of either. */
export function askedLines(
  db: Database,
  viewer: User | undefined,
  view: AskedView = DEFAULT_VIEW,
): { thoughts: AskedLine[]; asks: AskedLine[] } {
  if (viewer === undefined) return { thoughts: [], asks: [] };
  const repos = askedRepos(db, viewer, null);
  return {
    thoughts: thoughtStream(db, viewer, { limit: 50 }).map(thoughtLine),
    // MCP's order, not /asked's needs-the-owner grouping: the title names the order, so the rows keep it.
    asks: askedIn(db, repos, view).map(askLine),
  };
}

export function askedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let lines: AskedLine[] = [];
  let thoughtCount = 0;
  let view = DEFAULT_VIEW;
  const open = (index: number): void => {
    const line = lines[index];
    if (line?.path !== undefined) openOnWeb(f, ctx, line.path, "That ask");
  };
  const read = (): void => {
    const got = askedLines(f.db, f.user, view);
    lines = [...got.thoughts, ...got.asks];
    thoughtCount = got.thoughts.length;
    state.clamp(lines.length);
  };
  return {
    get title() {
      return `Asked · ${viewWords(view)}`;
    },
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["s"], "show"),
      binding(["o"], "order"),
      binding(["r"], "refresh"),
    ],
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      // The title names the choice; the head line only counts.
      const sentence = `${thoughtCount} thoughts · ${lines.length - thoughtCount} asks`;
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
      if (e.key === "s" || e.key === "o") {
        view = e.key === "s"
          ? { ...view, show: nextShow(view.show) }
          : { ...view, order: view.order === "oldest" ? "newest" : "oldest" };
        state.index = 0;
        state.offset = 0;
        read();
        ctx.invalidate();
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
