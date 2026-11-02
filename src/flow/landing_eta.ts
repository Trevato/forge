/**
 * When an approved pull lands (#6548, part of #5930): a pure read from its
 * place in the merge queue and the recent landing pace, so an approved pull
 * says how long it will wait and nobody pokes it.
 *
 * The pull lands after the `ahead` pulls in front of it and then itself:
 *
 *   minutes = (ahead + 1) × per landing
 *   per landing = 60 / landedLastHour     when anything landed in the last hour
 *               = medianGateMinutes        otherwise, one gate after another
 *
 * The observed pace wins over the gate time when both are known: it already
 * counts batching, red gates and the queue's idle gaps. With neither there is
 * no estimate (null). Plain data in, plain data out; no clock read.
 */

export interface LandingEtaInput {
  /** Pulls in front of this one in the queue; 0 is first in line. */
  readonly ahead: number;
  /** Pulls the queue landed in the last hour. */
  readonly landedLastHour: number;
  /** The median merge-queue gate in minutes, or null when none is known. */
  readonly medianGateMinutes: number | null;
}

const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Minutes until the pull lands, or null when nothing landed in the last hour and no gate time is known. */
export function landingEta(input: LandingEtaInput): number | null {
  const slots = count(input.ahead) + 1;
  const landed = Number.isFinite(input.landedLastHour) && input.landedLastHour > 0 ? input.landedLastHour : 0;
  if (landed > 0) return (slots * 60) / landed;
  const gate = input.medianGateMinutes;
  if (gate !== null && Number.isFinite(gate) && gate > 0) return slots * gate;
  return null;
}

/**
 * The estimate in words. Under an hour it rounds to the nearest 5 min (at
 * least 5): "lands in about 40 min"; from 57.5 min on, to the nearest hour
 * (at least 1): "lands in about 3 h". An estimate is not a promise, so it
 * says no more precision than the pace can carry.
 */
export function etaSays(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return "no estimate: nothing landed in the last hour";
  const five = Math.max(5, Math.round(minutes / 5) * 5);
  if (five < 60) return `lands in about ${five} min`;
  return `lands in about ${Math.max(1, Math.round(minutes / 60))} h`;
}
