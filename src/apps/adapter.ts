/**
 * `adapter` (top level of `forge.json`): the app is an adapter, an app the
 * forge pulls from on a schedule (#437). The block says how often:
 *
 *     { "adapter": { "schedule": { "every": 900 } } }
 *
 * `every` is whole seconds, 60 (one minute) to 86400 (one day). Pure: plain
 * data in, plain data or one sentence naming the field out. Unknown keys are
 * refused at every level, so a misspelt `scheduel` fails the manifest instead
 * of silently meaning "no schedule".
 */

import { err, ok, type Result } from "../kernel/result.ts";

export interface AdapterSpec {
  readonly schedule: {
    /** Seconds between pulls, an integer in [EVERY_MIN, EVERY_MAX]. */
    readonly every: number;
  };
}

/** One minute: more often than this is a poll loop, not a schedule. */
export const EVERY_MIN = 60;
/** One day. */
export const EVERY_MAX = 86_400;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The keys `allowed` does not name, quoted, for the error sentence. */
function unknownKeys(value: Json, allowed: readonly string[]): string | undefined {
  const stray = Object.keys(value).filter((k) => !allowed.includes(k));
  return stray.length === 0 ? undefined : stray.map((k) => JSON.stringify(k)).join(", ");
}

/**
 * The parsed `adapter` block, `undefined` when it is absent. `raw` is the
 * value of the top-level `adapter` key exactly as `JSON.parse` gave it.
 */
export function parseAdapter(raw: unknown): Result<AdapterSpec | undefined, string> {
  if (raw === undefined) return ok(undefined);
  if (!isObject(raw)) return err("forge.json: adapter must be an object");
  const strayTop = unknownKeys(raw, ["schedule"]);
  if (strayTop !== undefined)
    return err(`forge.json: adapter takes only schedule, not ${strayTop}`);
  const schedule = raw["schedule"];
  if (schedule === undefined) return err("forge.json: adapter.schedule is required");
  if (!isObject(schedule)) return err("forge.json: adapter.schedule must be an object");
  const straySchedule = unknownKeys(schedule, ["every"]);
  if (straySchedule !== undefined)
    return err(`forge.json: adapter.schedule takes only every, not ${straySchedule}`);
  const every = schedule["every"];
  if (
    typeof every !== "number" ||
    !Number.isInteger(every) ||
    every < EVERY_MIN ||
    every > EVERY_MAX
  )
    return err(
      `forge.json: adapter.schedule.every must be a whole number of seconds, ${EVERY_MIN}–${EVERY_MAX}`,
    );
  return ok({ schedule: { every } });
}
