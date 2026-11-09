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
import { NO_CLOUD_BODY, labelInput } from "../core/placement_policy.ts";
import { CLOUD_BODY_CONFIGURED } from "../spawn/placement.ts";
import {
  economicsChanges,
  getEconomics,
  getOwnedNodeLabel,
  setEconomics,
  setOwnedNodeLabel,
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
  return {
    ...now,
    policy,
    words: policyWords(policy),
    placement: placementView(app, policy),
    changes: economicsChanges(app.db),
  };
}

export function readEconomics(app: App, actor: User | undefined): Result<EconomicsView, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok(view(app)) : who;
}

export type EconomicsError = "not_found" | "bad_position" | "bad_margin" | "bad_label";

export const ECONOMICS_WORDS: Record<Exclude<EconomicsError, "not_found">, string> = {
  bad_position: "position is a whole number from 0 to 100",
  bad_margin: `marginPct is a whole number from 0 to ${MARGIN_MAX}`,
  bad_label: "ownedNodeLabel is a node label as key=value, e.g. plat.sh/site=vxrail, or blank for that default",
};

/**
 * Set either number, the owned-node label, or any of them; one left
 * `undefined` keeps what stands. A value given but not valid — a number not
 * whole and in range, a label not `key=value` — refuses the whole change.
 */
export function changeEconomics(
  app: App,
  actor: User | undefined,
  input: { position?: unknown; marginPct?: unknown; ownedNodeLabel?: unknown },
): Result<EconomicsView, EconomicsError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const before = getEconomics(app.db);
  const position = input.position === undefined ? before.position : parsePosition(input.position);
  if (position === undefined) return err("bad_position");
  const marginPct = input.marginPct === undefined ? before.marginPct : parseMarginPct(input.marginPct);
  if (marginPct === undefined) return err("bad_margin");
  // Blank is the default label again; anything not `key=value` refuses the change.
  const label = input.ownedNodeLabel === undefined ? undefined : labelInput(input.ownedNodeLabel);
  if (input.ownedNodeLabel !== undefined && label === undefined) return err("bad_label");
  setEconomics(app.db, { position, marginPct }, who.value.id);
  if (label !== undefined) setOwnedNodeLabel(app.db, label, who.value.id);
  return ok(view(app));
}
