/**
 * The forge's economics (`settings/economics.ts`) for a forge admin who is a
 * person: the profit slider's position, the margin on crew spend, the policy
 * the position means (`core/slider.ts`) and the last changes. Never an agent:
 * a crew run that could move the slider would decide its own cost. Everyone
 * else is told `not_found`. Validation is here, once, for the page and the
 * API alike: whole numbers in range, nothing else.
 */

import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  MARGIN_MAX,
  parseMarginPct,
  parsePosition,
  policyAt,
  policyWords,
  type Policy,
} from "../core/slider.ts";
import {
  economicsChanges,
  getEconomics,
  setEconomics,
  type Economics,
  type EconomicsChange,
} from "../settings/economics.ts";

export interface EconomicsView extends Economics {
  readonly policy: Policy;
  readonly words: string;
  readonly changes: EconomicsChange[];
}

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

function view(app: App): EconomicsView {
  const now = getEconomics(app.db);
  const policy = policyAt(now.position);
  return { ...now, policy, words: policyWords(policy), changes: economicsChanges(app.db) };
}

export function readEconomics(app: App, actor: User | undefined): Result<EconomicsView, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok(view(app)) : who;
}

export type EconomicsError = "not_found" | "bad_position" | "bad_margin";

export const ECONOMICS_WORDS: Record<Exclude<EconomicsError, "not_found">, string> = {
  bad_position: "position is a whole number from 0 to 100",
  bad_margin: `marginPct is a whole number from 0 to ${MARGIN_MAX}`,
};

/**
 * Set either number or both; one left `undefined` keeps what stands. A value
 * given but not a whole number in range refuses the whole change.
 */
export function changeEconomics(
  app: App,
  actor: User | undefined,
  input: { position?: unknown; marginPct?: unknown },
): Result<EconomicsView, EconomicsError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const before = getEconomics(app.db);
  const position = input.position === undefined ? before.position : parsePosition(input.position);
  if (position === undefined) return err("bad_position");
  const marginPct = input.marginPct === undefined ? before.marginPct : parseMarginPct(input.marginPct);
  if (marginPct === undefined) return err("bad_margin");
  setEconomics(app.db, { position, marginPct }, who.value.id);
  return ok(view(app));
}
