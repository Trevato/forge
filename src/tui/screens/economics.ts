/**
 * The profit slider in the terminal, a forge admin's: the position, the
 * margin on crew spend, the label that selects owned nodes and the
 * operator's four prices, with the policy the position means as the head
 * line, where bursts go under it, and this month's cost (`core/cost.ts`) as
 * the foot, as /settings/economics and /api/v1/forge/economics have them.
 * `e` asks for the value, shows the plan, and changes it only after a
 * confirm, through `changeEconomics`. The gate is the action's: an admin who
 * is not an agent; anyone else sees nothing and changes nothing.
 */

import { ECONOMICS_WORDS, changeEconomics, readEconomics, type EconomicsView } from "../../actions/economics.ts";
import {
  MARGIN_MAX,
  POSITION_MAX,
  POSITION_MIN,
  PRICE_MAX_CENTS,
  SLOTS_MAX,
  parseMarginPct,
  parsePosition,
  parseSlots,
  parseUsdCents,
  usdOfCents,
} from "../../core/slider.ts";
import { OWNED_NODE_LABEL_DEFAULT, labelInput } from "../../core/placement_policy.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/**
 * One value the screen can change. `parse` reads what was typed into the
 * stored unit (a whole number, whole cents for a price, a label); `send`
 * turns it into what `changeEconomics` takes (dollars for a price).
 */
type Value = number | string;

interface Lever {
  readonly key: string;
  readonly now: (e: EconomicsView) => Value;
  readonly parse: (raw: string) => Value | undefined;
  readonly show: (v: Value) => string;
  readonly send: (v: Value) => Record<string, Value>;
  readonly ask: string;
  readonly words: string;
  readonly unit: string;
  readonly range: string;
}

const whole = (key: string) => ({
  key,
  show: (v: Value) => String(v),
  send: (v: Value) => ({ [key]: v }),
  ask: "a whole number",
});

const price = (key: string, now: (e: EconomicsView) => number, unit: string): Lever => ({
  key,
  now,
  parse: parseUsdCents,
  show: (cents) => usdOfCents(Number(cents)),
  send: (cents) => ({ [key]: Number(cents) / 100 }),
  ask: "US dollars, at most two decimals",
  words: ECONOMICS_WORDS.bad_price,
  unit,
  range: `0–${usdOfCents(PRICE_MAX_CENTS)}`,
});

const LEVERS: readonly Lever[] = [
  {
    ...whole("position"),
    now: (e) => e.position,
    parse: parsePosition,
    words: ECONOMICS_WORDS.bad_position,
    unit: "0 cheapest, 100 most responsive",
    range: `${POSITION_MIN}–${POSITION_MAX}`,
  },
  {
    ...whole("marginPct"),
    now: (e) => e.marginPct,
    parse: parseMarginPct,
    words: ECONOMICS_WORDS.bad_margin,
    unit: "% on crew spend",
    range: `0–${MARGIN_MAX}`,
  },
  {
    ...whole("ownedNodeLabel"),
    now: (e) => e.placement.ownedNodeLabel,
    parse: labelInput,
    ask: "a node label, key=value",
    words: ECONOMICS_WORDS.bad_label,
    unit: "selects owned metal",
    range: `blank: ${OWNED_NODE_LABEL_DEFAULT}`,
  },
  price("ownedMonthUsd", (e) => e.prices.ownedMonthCents, "$/month for the owned box"),
  {
    ...whole("ownedSlots"),
    now: (e) => e.prices.ownedSlots,
    parse: parseSlots,
    words: ECONOMICS_WORDS.bad_slots,
    unit: "app-slots the owned box holds",
    range: `0–${SLOTS_MAX}`,
  },
  price("cloudHourUsd", (e) => e.prices.cloudHourCents, "$/awake-hour on cloud"),
  price("storageGbMonthUsd", (e) => e.prices.storageGbMonthCents, "$/GB-month kept"),
  price("awakePriceHourUsd", (e) => e.prices.awakePriceHourCents, "list $/awake-hour a customer pays"),
  price("storagePriceGbMonthUsd", (e) => e.prices.storagePriceGbMonthCents, "list $/GB-month a customer pays"),
];

/** "This month so far: owned $60.00 · cloud $0.00 · … · total $61.50". */
function monthWords(e: EconomicsView): string {
  const c = e.month.cost;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return `This month so far: owned ${usd(c.owned)} · cloud ${usd(c.cloud)} · storage ${usd(c.storage)} · crew ${usd(c.crew)} · total ${usd(c.total)}`;
}

export function economicsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => readEconomics(f.app, f.user);

  const apply = (lever: Lever, to: Value): void => {
    const made = changeEconomics(f.app, f.user, lever.send(to));
    note = !made.ok
      ? "You cannot change the economics."
      : lever.key === "position"
        ? `position is ${to}: ${made.value.words}.`
        : `${lever.key} is ${lever.show(to)}.`;
    ctx.invalidate();
  };

  const ask = (lever: Lever, now: EconomicsView): void => {
    const from = lever.show(lever.now(now));
    ctx.push(
      promptScreen(ctx, screen, {
        title: lever.key,
        label: `${lever.ask}, ${lever.range}`,
        value: from,
        hint: lever.unit,
        onSubmit: (raw) => {
          const to = lever.parse(raw);
          if (to === undefined) return lever.words;
          return Promise.resolve().then(() => {
            ctx.push(
              confirmScreen(ctx, screen, {
                title: "Change the economics",
                body: [`${lever.key}: ${from} → ${lever.show(to)}`],
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
    LEVERS.map((l) => ({ title: l.key, secondary: `${l.show(l.now(e))} · ${l.unit}`, meta: l.range }));

  const screen: Screen = {
    title: "Economics",
    keys: [binding(["j", "k"], "move cursor"), binding(["e"], "change")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, where, list, foot] = split(area, "v", [len(1), len(1), fill(1), len(1)]);
      const r = read();
      const text = note !== "" ? note : r.ok ? `At ${r.value.position}: ${r.value.words}.` : "The economics are set by a forge admin.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (r.ok) {
        const placed = `Placement: ${r.value.placement.words}.`;
        s.text(where!.x, where!.y, truncate(placed, where!.w), style(c.mutedFg, c.bg), where!.x + where!.w);
      }
      drawList(s, list!, c, state, r.ok ? rows(r.value) : []);
      if (r.ok) s.text(foot!.x, foot!.y, truncate(monthWords(r.value), foot!.w), style(c.fg, c.bg), foot!.x + foot!.w);
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

/** The profit slider and the prices, as /settings/economics has them: an admin who is not an agent (#504, #507). */
export const entry: PaletteEntry = {
  id: "economics",
  title: "Economics",
  hint: "the profit slider's position, the margin, the owned-node label and the prices; change one",
  after: ["limits"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(economicsScreen(session, ctx)),
};
