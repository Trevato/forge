/**
 * `adapter` (top level of `forge.json`): the app is an adapter, an app the
 * forge pulls from on a schedule (#437, docs/ADAPTERS.md). The block says how
 * often, and may say what it pulls from and which settings it reads:
 *
 *     { "adapter": {
 *         "schedule": { "every": 900 },
 *         "source": { "name": "Shop API", "hosts": ["api.shop.example"] },
 *         "config": { "token": { "type": "secret", "env": "SHOP_TOKEN", "required": true } } } }
 *
 * `every` is whole seconds, 60 (one minute) to 86400 (one day). Pure: plain
 * data in, plain data or one sentence naming the field out. Unknown keys are
 * refused at every level, so a misspelt `scheduel` fails the manifest instead
 * of silently meaning "no schedule".
 *
 * Config carries names, never values: a secret field points at an operator
 * variable (`core/app_env.ts`), so whoever reads the code reads no credential.
 */

import { isReservedAppEnvName } from "../core/app_env.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type AdapterFieldType = "string" | "number" | "boolean" | "secret";

export interface AdapterField {
  readonly name: string;
  readonly type: AdapterFieldType;
  /** The environment variable the adapter reads it from. */
  readonly env: string;
  readonly required: boolean;
  /** Absent on a secret, and wherever none is declared. */
  readonly default?: string | number | boolean | undefined;
}

export interface AdapterSource {
  readonly name: string;
  /** The hosts it reads from; each must also be in `egress` (`manifest.ts`). */
  readonly hosts: readonly string[];
}

export interface AdapterSpec {
  readonly schedule: {
    /** Seconds between pulls, an integer in [EVERY_MIN, EVERY_MAX]. */
    readonly every: number;
  };
  readonly source?: AdapterSource | undefined;
  readonly config?: readonly AdapterField[] | undefined;
}

/** One minute: more often than this is a poll loop, not a schedule. */
export const EVERY_MIN = 60;
/** One day. */
export const EVERY_MAX = 86_400;

const HOSTS_MAX = 8;
const FIELDS_MAX = 32;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const TYPES: readonly string[] = ["string", "number", "boolean", "secret"];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bad = (message: string): Result<never, string> =>
  err(`forge.json: adapter.${message}`);

/** The keys `allowed` does not name, quoted, for the error sentence. */
function unknownKeys(value: Json, allowed: readonly string[]): string | undefined {
  const stray = Object.keys(value).filter((k) => !allowed.includes(k));
  return stray.length === 0 ? undefined : stray.map((k) => JSON.stringify(k)).join(", ");
}

/** A bare lowercase hostname: no scheme, port, path, wildcard or address. */
const isSourceHost = (value: string): boolean =>
  HOST.test(value) && !/^[0-9.]+$/.test(value);

/**
 * The parsed `adapter` block, `undefined` when it is absent. `raw` is the
 * value of the top-level `adapter` key exactly as `JSON.parse` gave it.
 */
export function parseAdapter(raw: unknown): Result<AdapterSpec | undefined, string> {
  if (raw === undefined) return ok(undefined);
  if (!isObject(raw)) return err("forge.json: adapter must be an object");
  const strayTop = unknownKeys(raw, ["schedule", "source", "config"]);
  if (strayTop !== undefined)
    return err(`forge.json: adapter takes only schedule, source and config, not ${strayTop}`);
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
  const source = parseSource(raw["source"]);
  if (!source.ok) return source;
  const config = parseConfig(raw["config"]);
  if (!config.ok) return config;
  return ok({
    schedule: { every },
    ...(source.value === undefined ? {} : { source: source.value }),
    ...(config.value === undefined ? {} : { config: config.value }),
  });
}

function parseSource(raw: unknown): Result<AdapterSource | undefined, string> {
  if (raw === undefined) return ok(undefined);
  if (!isObject(raw)) return bad("source must be an object");
  const stray = unknownKeys(raw, ["name", "hosts"]);
  if (stray !== undefined) return bad(`source takes only name and hosts, not ${stray}`);
  const name = raw["name"];
  if (typeof name !== "string" || !/^[\w .-]{1,60}$/.test(name))
    return bad("source.name must be 1–60 letters, digits, spaces, dots or dashes");
  const hosts = raw["hosts"];
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > HOSTS_MAX)
    return bad(`source.hosts must list 1–${HOSTS_MAX} hostnames`);
  for (const host of hosts)
    if (typeof host !== "string" || !isSourceHost(host))
      return bad("source.hosts entries must be bare lowercase hostnames (no scheme, port or path)");
  return ok({ name, hosts: hosts as string[] });
}

function parseConfig(raw: unknown): Result<AdapterField[] | undefined, string> {
  if (raw === undefined) return ok(undefined);
  if (!isObject(raw)) return bad("config must be an object");
  const names = Object.keys(raw);
  if (names.length > FIELDS_MAX) return bad(`config may name at most ${FIELDS_MAX} fields`);
  const fields: AdapterField[] = [];
  for (const fieldName of names) {
    const f = raw[fieldName];
    if (!FIELD_NAME.test(fieldName))
      return bad(`config.${fieldName}: names are lowercase letters, digits and _`);
    if (!isObject(f)) return bad(`config.${fieldName} must be an object`);
    const stray = unknownKeys(f, ["type", "env", "required", "default"]);
    if (stray !== undefined)
      return bad(`config.${fieldName} takes only type, env, required and default, not ${stray}`);
    const type = f["type"];
    if (typeof type !== "string" || !TYPES.includes(type))
      return bad(`config.${fieldName}.type must be one of ${TYPES.join(", ")}`);
    const env = f["env"];
    if (typeof env !== "string" || !ENV_NAME.test(env) || isReservedAppEnvName(env))
      return bad(`config.${fieldName}.env must name an operator variable (A–Z, 0–9, _) the forge does not own`);
    const def = f["default"];
    if (type === "secret") {
      if (def !== undefined)
        return bad(`config.${fieldName} is a secret: it names a variable, it never holds a value`);
    } else if (def !== undefined && typeof def !== type)
      return bad(`config.${fieldName}.default must be a ${type}`);
    if (typeof def === "string" && def.length > 200)
      return bad(`config.${fieldName}.default is too long`);
    if (f["required"] !== undefined && typeof f["required"] !== "boolean")
      return bad(`config.${fieldName}.required must be true or false`);
    fields.push({
      name: fieldName,
      type: type as AdapterFieldType,
      env,
      required: f["required"] === true,
      ...(def === undefined ? {} : { default: def as string | number | boolean }),
    });
  }
  return ok(fields);
}
