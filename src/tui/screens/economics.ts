/**
 * The profit slider in the terminal, a forge admin's: the position, the
 * margin on crew spend and the label that selects owned nodes, with the
 * policy the position means as the head line and where bursts go under it,
 * as /settings/economics and /api/v1/forge/economics have them. `e` asks for
 * the value, shows the plan, and changes it only after a confirm,
 * through `changeEconomics`. The gate is the action's: an admin who is not
 * an agent; anyone else sees nothing and changes nothing.
 */

import { ECONOMICS_WORDS, changeEconomics, readEconomics, type EconomicsView } from "../../actions/economics.ts";
import { MARGIN_MAX, POSITION_MAX, POSITION_MIN, parseMarginPct, parsePosition } from "../../core/slider.ts";
import { OWNED_NODE_LABEL_DEFAULT, labelInput } from "../../core/placement_policy.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

interface Lever {
  readonly key: "position" | "marginPct" | "ownedNodeLabel";
  readonly parse: (raw: string) => number | string | undefined;
  readonly now: (e: EconomicsView) => number | string;
  readonly words: string;
  /** What the prompt asks for. */
  readonly asks: string;
  readonly unit: string;
  readonly range: string;
}

const LEVERS: readonly Lever[] = [
  {
    key: "position",
    parse: parsePosition,
    now: (e) => e.position,
    words: ECONOMICS_WORDS.bad_position,
    asks: `a whole number, ${POSITION_MIN}–${POSITION_MAX}`,
    unit: "0 cheapest, 100 most responsive",
    range: `${POSITION_MIN}–${POSITION_MAX}`,
  },
  {
    key: "marginPct",
    parse: parseMarginPct,
    now: (e) => e.marginPct,
    words: ECONOMICS_WORDS.bad_margin,
    asks: `a whole number, 0–${MARGIN_MAX}`,
    unit: "% on crew spend",
    range: `0–${MARGIN_MAX}`,
  },
  {
    key: "ownedNodeLabel",
    parse: labelInput,
    now: (e) => e.placement.ownedNodeLabel,
    words: ECONOMICS_WORDS.bad_label,
    asks: "a node label, key=value",
    unit: "selects owned metal",
    range: `blank: ${OWNED_NODE_LABEL_DEFAULT}`,
  },
];

export function economicsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => readEconomics(f.app, f.user);

  const apply = (lever: Lever, to: number | string): void => {
    const made = changeEconomics(f.app, f.user, { [lever.key]: to });
    note = made.ok ? `${lever.key} is ${to}: ${made.value.words}.` : "You cannot change the economics.";
    ctx.invalidate();
  };

  const ask = (lever: Lever, now: EconomicsView): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: lever.key,
        label: lever.asks,
        value: String(lever.now(now)),
        hint: lever.unit,
        onSubmit: (raw) => {
          const to = lever.parse(raw);
          if (to === undefined) return lever.words;
          return Promise.resolve().then(() => {
            ctx.push(
              confirmScreen(ctx, screen, {
                title: "Change the economics",
                body: [`${lever.key}: ${lever.now(now)} → ${to}`],
                actions: [{ label: "Keep", variant: "ghost" }, { label: "Change" }],
                onChoose: (i) => {
                  if (i === 1) apply(lever, to);
                },
              }),
            );
          });
        },
      }),
    );
  };

  const rows = (e: EconomicsView): ListRow[] =>
    LEVERS.map((l) => ({ title: l.key, secondary: `${l.now(e)} · ${l.unit}`, meta: l.range }));

  const screen: Screen = {
    title: "Economics",
    keys: [binding(["j", "k"], "move cursor"), binding(["e"], "change")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, where, list] = split(area, "v", [len(1), len(1), fill(1)]);
      const r = read();
      const text = note !== "" ? note : r.ok ? `At ${r.value.position}: ${r.value.words}.` : "The economics are set by a forge admin.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (r.ok) {
        const placed = `Placement: ${r.value.placement.words}.`;
        s.text(where!.x, where!.y, truncate(placed, where!.w), style(c.mutedFg, c.bg), where!.x + where!.w);
      }
      drawList(s, list!, c, state, r.ok ? rows(r.value) : []);
    },
    key(e) {
      const r = read();
      if (!r.ok) return false;
      if (state.key(e, LEVERS.length)) return true;
      if (e.ctrl || e.alt || e.key !== "e") return false;
      const lever = LEVERS[state.index];
      if (lever === undefined) return false;
      ask(lever, r.value);
      return true;
    },
  };
  return screen;
}

/** The profit slider, as /settings/economics has it: an admin who is not an agent (#504). */
export const entry: PaletteEntry = {
  id: "economics",
  title: "Economics",
  hint: "the profit slider's position and the margin; change one",
  after: ["limits"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(economicsScreen(session, ctx)),
};
