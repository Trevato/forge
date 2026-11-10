/**
 * The forge's economics (`settings/economics.ts`) for a forge admin who is a
 * person: the profit slider's position, the margin on crew spend, the policy
 * the position means (`core/slider.ts`), the operator's prices and what this
 * month has cost so far at them (`core/cost.ts`), and the last changes. Never an agent:
 * a crew run that could move the slider would decide its own cost. Everyone
 * else is told `not_found`. Validation is here, once, for the page and the
 * API alike: whole numbers in range, nothing else.
 */

import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { costOf, monthSoFar, type Cost, type Range } from "../core/cost.ts";
import { usageBetween } from "../core/meter.ts";
import { usageTotals } from "../core/usage.ts";
import {
  MARGIN_MAX,
  PRICE_MAX_CENTS,
  SLOTS_MAX,
  parseMarginPct,
  parsePosition,
  parseSlots,
  parseUsdCents,
  policyAt,
  policyWords,
  usdOfCents,
  type Policy,
  type Prices,
} from "../core/slider.ts";
import { NO_CLOUD_BODY, labelInput } from "../core/placement_policy.ts";
import { CLOUD_BODY_CONFIGURED } from "../spawn/placement.ts";
import {
  economicsChanges,
  getEconomics,
  getOwnedNodeLabel,
  getPrices,
  setEconomics,
  setOwnedNodeLabel,
  setPrices,
  type Economics,
  type EconomicsChange,
} from "../settings/economics.ts";

/** Where work runs (`core/placement_policy.ts`): owned first, bursts to a cloud body if one is configured. */
export interface PlacementView {
  readonly cloudBody: boolean;
  /** The label that selects owned nodes, passed to the body on owned metal. */
  readonly ownedNodeLabel: string;
  /** "no cloud body: bursts queue", or where bursts go. */
  readonly words: string;
}

export interface EconomicsView extends Economics {
  readonly policy: Policy;
  readonly words: string;
  readonly placement: PlacementView;
  readonly changes: EconomicsChange[];
  readonly prices: Prices;
  /** The UTC calendar month so far, and what it cost at `prices`. */
  readonly month: Range & { readonly cost: Cost };
}

function placementView(app: App, policy: Policy): PlacementView {
  const cloudBody = CLOUD_BODY_CONFIGURED as boolean;
  return {
    cloudBody,
    ownedNodeLabel: getOwnedNodeLabel(app.db),
    words: cloudBody
      ? `previews spill to cloud at ${Math.round(policy.spillAtOwnedUse * 1000) / 10}% of owned capacity, production when owned is full`
      : NO_CLOUD_BODY,
  };
}

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

function view(app: App): EconomicsView {
  const now = getEconomics(app.db);
  const policy = policyAt(now.position);
  const prices = getPrices(app.db);
  const range = monthSoFar(new Date().toISOString());
  const cost = costOf(
    usageBetween(app.db, range.from, range.to, range.to),
    usageTotals(app.db, "kind", { since: range.from, until: range.to }),
    prices,
    range,
  );
  return {
    ...now,
    policy,
    words: policyWords(policy),
    placement: placementView(app, policy),
    changes: economicsChanges(app.db),
    prices,
    month: { ...range, cost },
  };
}

export function readEconomics(app: App, actor: User | undefined): Result<EconomicsView, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok(view(app)) : who;
}

export type EconomicsError = "not_found" | "bad_position" | "bad_margin" | "bad_price" | "bad_slots" | "bad_label";

export const ECONOMICS_WORDS: Record<Exclude<EconomicsError, "not_found">, string> = {
  bad_position: "position is a whole number from 0 to 100",
  bad_margin: `marginPct is a whole number from 0 to ${MARGIN_MAX}`,
  bad_price: `a price is US dollars from 0 to ${usdOfCents(PRICE_MAX_CENTS)} with at most two decimals`,
  bad_slots: `ownedSlots is a whole number from 0 to ${SLOTS_MAX}`,
  bad_label: "ownedNodeLabel is a node label as key=value, e.g. plat.sh/site=vxrail, or blank for that default",
};

/** The prices on the wire and in the form: dollars, not cents. */
export interface PriceInput {
  ownedMonthUsd?: unknown;
  ownedSlots?: unknown;
  cloudHourUsd?: unknown;
  storageGbMonthUsd?: unknown;
  /** List price a customer pays, $/awake-hour (#508). */
  awakePriceHourUsd?: unknown;
  /** List price a customer pays, $/GB-month (#508). */
  storagePriceGbMonthUsd?: unknown;
}

function readPrices(before: Prices, input: PriceInput): Result<Prices, "bad_price" | "bad_slots"> {
  const usd = (v: unknown, kept: number) => (v === undefined ? kept : parseUsdCents(v));
  const ownedMonthCents = usd(input.ownedMonthUsd, before.ownedMonthCents);
  const cloudHourCents = usd(input.cloudHourUsd, before.cloudHourCents);
  const storageGbMonthCents = usd(input.storageGbMonthUsd, before.storageGbMonthCents);
  const awakePriceHourCents = usd(input.awakePriceHourUsd, before.awakePriceHourCents);
  const storagePriceGbMonthCents = usd(input.storagePriceGbMonthUsd, before.storagePriceGbMonthCents);
  if (
    ownedMonthCents === undefined ||
    cloudHourCents === undefined ||
    storageGbMonthCents === undefined ||
    awakePriceHourCents === undefined ||
    storagePriceGbMonthCents === undefined
  )
    return err("bad_price");
  const ownedSlots = input.ownedSlots === undefined ? before.ownedSlots : parseSlots(input.ownedSlots);
  if (ownedSlots === undefined) return err("bad_slots");
  return ok({ ownedMonthCents, ownedSlots, cloudHourCents, storageGbMonthCents, awakePriceHourCents, storagePriceGbMonthCents });
}

/**
 * Set any of the numbers or the owned-node label; one left `undefined`
 * keeps what stands. A value given but not valid (a whole number in range;
 * a price of at most two decimals, non-negative; a label not `key=value`)
 * refuses the whole change.
 */
export function changeEconomics(
  app: App,
  actor: User | undefined,
  input: { position?: unknown; marginPct?: unknown; ownedNodeLabel?: unknown } & PriceInput,
): Result<EconomicsView, EconomicsError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const before = getEconomics(app.db);
  const position = input.position === undefined ? before.position : parsePosition(input.position);
  if (position === undefined) return err("bad_position");
  const marginPct = input.marginPct === undefined ? before.marginPct : parseMarginPct(input.marginPct);
  if (marginPct === undefined) return err("bad_margin");
  const prices = readPrices(getPrices(app.db), input);
  if (!prices.ok) return prices;
  // Blank is the default label again; anything not `key=value` refuses the change.
  const label = input.ownedNodeLabel === undefined ? undefined : labelInput(input.ownedNodeLabel);
  if (input.ownedNodeLabel !== undefined && label === undefined) return err("bad_label");
  setEconomics(app.db, { position, marginPct }, who.value.id);
  setPrices(app.db, prices.value, who.value.id);
  if (label !== undefined) setOwnedNodeLabel(app.db, label, who.value.id);
  return ok(view(app));
}
