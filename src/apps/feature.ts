/**
 * An app the forge can take in as one of its own features ("absorb").
 * The app says so in `forge.json`:
 *
 *   "feature": {
 *     "name": "Radar",
 *     "summary": "What the platform runs against what exists",
 *     "page": "/",
 *     "settings": {
 *       "runDays": { "type": "days", "default": ["mon", "thu"], "label": "Run on" },
 *       "runHourUtc": { "type": "int", "default": 13, "min": 0, "max": 23, "label": "Hour (UTC)" }
 *     }
 *   }
 *
 * Declaring is not absorbing: nothing changes until an admin absorbs the app
 * (`actions/features.ts`). Once absorbed, the forge keeps the settings, shows
 * them as its own, and hands them to the app's process as `FORGE_SETTING_*`.
 * The app's code never runs in the forge: it stays in its own cell.
 *
 * Pure: parsing and checking values, no database and no git. Fail closed, as
 * the rest of `forge.json` is: a block that is present and wrong is refused
 * with the field named, never guessed at.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { isTimezone } from "./cron.ts";
import { parseTools, type ToolSpec } from "./feature_tools.ts";

export type SettingType = "bool" | "int" | "string" | "choice" | "days" | "list" | "secret";

export const SETTING_TYPES: readonly SettingType[] = ["bool", "int", "string", "choice", "days", "list", "secret"];

/** The labels the forge's own menus use: a feature may not borrow one. */
const BUILT_IN_MENU_LABELS = [
  "your profile", "repositories", "apps", "notes", "talk", "explore", "packs", "displays", "map", "features",
  "new app", "new repository", "new issue", "new organization", "migrate", "settings", "access tokens", "ssh keys",
  "origins", "boards", "crew", "system memory", "help", "sign out", "log out", "sign in", "admin", "administration",
  "access codes", "computer keys", "connected accounts", "jump to anywhere",
  "theme", "create", "new forge", "create new", "appearance and help", "features from apps", "keyboard shortcuts",
];

const menuForm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** True when `name` reads as one of the forge's own menu labels. */
export function isBuiltInMenuLabel(name: string): boolean {
  return BUILT_IN_MENU_LABELS.includes(menuForm(name));
}

/** The days a `days` setting can name, in the order they are kept and shown. */
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export interface SettingSpec {
  /** The setting's name in `forge.json` and the API: `runHourUtc`. */
  readonly key: string;
  readonly type: SettingType;
  readonly label: string;
  readonly help?: string | undefined;
  /** The value as the forge keeps it: canonical text (see `checkSetting`). */
  readonly default: string;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly choices?: readonly string[] | undefined;
}

export interface FeatureSpec {
  readonly name: string;
  readonly summary: string | null;
  /** The app path the forge's nav opens. */
  readonly page: string;
  readonly settings: readonly SettingSpec[];
  /** MCP tools the app serves through the forge's `features` tool (`feature_tools.ts`). */
  readonly tools: readonly ToolSpec[];
  /** Tools the app asks the forge to call on a timer; empty when none. Fired by `apps/feature_schedule.ts`. */
  readonly schedule: readonly ScheduleEntry[];
}

/**
 * One scheduled tool: an interval (`everyMs`) or a daily clock time (`at` "07:15" in the IANA zone
 * `tz`), never both.
 */
export interface ScheduleEntry {
  readonly tool: string;
  readonly everyMs?: number | undefined;
  readonly at?: string | undefined;
  readonly tz?: string | undefined;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const MINUTE = 60_000;
/** The intervals a schedule entry may name. */
export const SCHEDULE_EVERY: Readonly<Record<string, number>> = { "15m": 15 * MINUTE, "1h": 60 * MINUTE, "6h": 360 * MINUTE, "1d": 1440 * MINUTE };
export const SCHEDULE_MAX = 4;

/** The `schedule` of a feature block, checked against the tools the feature declares; an error names the entry. */
function parseSchedule(raw: unknown, tools: readonly ToolSpec[]): Result<readonly ScheduleEntry[], string> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return bad("schedule must be a list of { tool, every } or { tool, at, tz }");
  if (raw.length > SCHEDULE_MAX) return bad(`schedule has at most ${SCHEDULE_MAX} entries`);
  const out: ScheduleEntry[] = [];
  for (const [i, e] of raw.entries()) {
    const at = `schedule entry ${i + 1}`;
    if (!isObject(e)) return bad(`${at} must be an object with tool and every, or tool, at and tz`);
    for (const extra of Object.keys(e)) if (!["tool", "every", "at", "tz"].includes(extra)) return bad(`${at}: unknown field ${extra}`);
    const tool = e["tool"];
    if (typeof tool !== "string" || !tools.some((t) => t.name === tool))
      return bad(`${at}: tool ${JSON.stringify(tool)} is not one of this feature's tools${tools.length ? ` (${tools.map((t) => t.name).join(", ")})` : ""}`);
    const every = e["every"];
    const clock = e["at"];
    const tz = e["tz"];
    if ((every === undefined) === (clock === undefined)) return bad(`${at} (${tool}): give exactly one of every and at`);
    if (every !== undefined) {
      if (tz !== undefined) return bad(`${at} (${tool}): tz goes with at, not every`);
      if (typeof every !== "string" || !Object.hasOwn(SCHEDULE_EVERY, every))
        return bad(`${at} (${tool}): every is one of ${Object.keys(SCHEDULE_EVERY).join(", ")}`);
      out.push({ tool, everyMs: SCHEDULE_EVERY[every]! });
      continue;
    }
    if (typeof clock !== "string" || !CLOCK.test(clock)) return bad(`${at} (${tool}): at is a 24-hour clock time like "07:15"`);
    if (typeof tz !== "string" || !isTimezone(tz)) return bad(`${at} (${tool}): tz is an IANA zone name like "America/Chicago"`);
    out.push({ tool, at: clock, tz });
  }
  return ok(out);
}

const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;
const CHOICE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const NAME_MAX = 40;
const SUMMARY_MAX = 200;
const LABEL_MAX = 60;
const HELP_MAX = 300;
const SETTINGS_MAX = 24;
/** The longest a `string` setting may be, and each item of a `list`. */
export const STRING_MAX = 500;
const LIST_MAX = 50;
const INT_LIMIT = 1_000_000_000;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (message: string) => err(`feature: ${message}`);

/**
 * The `feature` block of a parsed `forge.json`: `undefined` when there is
 * none, an error naming the field when it is wrong.
 */
export function parseFeature(forgeJson: Raw): Result<FeatureSpec | undefined, string> {
  const block = forgeJson["feature"];
  if (block === undefined) return ok(undefined);
  if (!isObject(block)) return bad("must be an object");
  const name = block["name"];
  if (typeof name !== "string" || name.trim() === "" || name.length > NAME_MAX)
    return bad(`name is text of 1 to ${NAME_MAX} characters`);
  if (isBuiltInMenuLabel(name)) return bad("name is already a label in the forge's own menu");
  const summary = block["summary"];
  if (summary !== undefined && (typeof summary !== "string" || summary.length > SUMMARY_MAX))
    return bad(`summary is text of at most ${SUMMARY_MAX} characters`);
  const page = block["page"] ?? "/";
  if (typeof page !== "string" || !page.startsWith("/") || page.startsWith("//") || page.length > 200 || /[\s\\]/.test(page))
    return bad("page is a path on the app, starting with /");
  const rawSettings = block["settings"] ?? {};
  if (!isObject(rawSettings)) return bad("settings must be an object of name → setting");
  const keys = Object.keys(rawSettings);
  if (keys.length > SETTINGS_MAX) return bad(`at most ${SETTINGS_MAX} settings`);
  const settings: SettingSpec[] = [];
  for (const key of keys) {
    const parsed = parseSetting(key, rawSettings[key]);
    if (!parsed.ok) return parsed;
    settings.push(parsed.value);
  }
  const envs = new Set(settings.map((s) => settingEnvName(s.key)));
  if (envs.size !== settings.length) return bad("two settings would share one FORGE_SETTING_ name");
  for (const extra of Object.keys(block))
    if (!["name", "summary", "page", "settings", "tools", "schedule"].includes(extra)) return bad(`unknown field ${extra}`);
  const tools = parseTools(block["tools"]);
  if (!tools.ok) return tools;
  const schedule = parseSchedule(block["schedule"], tools.value);
  if (!schedule.ok) return schedule;
  return ok({ tools: tools.value, schedule: schedule.value, name: name.trim(), summary: typeof summary === "string" && summary.trim() !== "" ? summary.trim() : null, page, settings });
}

function parseSetting(key: string, raw: unknown): Result<SettingSpec, string> {
  if (!KEY.test(key)) return bad(`setting ${JSON.stringify(key)}: names are camelCase, a letter first, at most 40 characters`);
  if (!isObject(raw)) return bad(`setting ${key} must be an object`);
  const type = raw["type"];
  if (typeof type !== "string" || !(SETTING_TYPES as readonly string[]).includes(type))
    return bad(`setting ${key}: type is one of ${SETTING_TYPES.join(", ")}`);
  const label = raw["label"] ?? key;
  if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX)
    return bad(`setting ${key}: label is text of 1 to ${LABEL_MAX} characters`);
  const help = raw["help"];
  if (help !== undefined && (typeof help !== "string" || help.length > HELP_MAX))
    return bad(`setting ${key}: help is text of at most ${HELP_MAX} characters`);
  for (const extra of Object.keys(raw))
    if (!["type", "label", "help", "default", "min", "max", "choices"].includes(extra))
      return bad(`setting ${key}: unknown field ${extra}`);
  let min: number | undefined;
  let max: number | undefined;
  let choices: string[] | undefined;
  if (type === "int") {
    for (const [field, v] of [["min", raw["min"]], ["max", raw["max"]]] as const)
      if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > INT_LIMIT))
        return bad(`setting ${key}: ${field} is a whole number`);
    min = raw["min"] as number | undefined;
    max = raw["max"] as number | undefined;
    if (min !== undefined && max !== undefined && min > max) return bad(`setting ${key}: min is above max`);
  } else if (raw["min"] !== undefined || raw["max"] !== undefined) {
    return bad(`setting ${key}: only an int has min and max`);
  }
  if (type === "choice") {
    const c = raw["choices"];
    if (!Array.isArray(c) || c.length < 2 || c.length > 20 || !c.every((x) => typeof x === "string" && CHOICE.test(x)) || new Set(c).size !== c.length)
      return bad(`setting ${key}: choices are 2 to 20 distinct lowercase words`);
    choices = c as string[];
  } else if (raw["choices"] !== undefined) {
    return bad(`setting ${key}: only a choice has choices`);
  }
  const spec = { key, type: type as SettingType, label: label.trim(), help: typeof help === "string" ? help : undefined, min, max, choices, default: "" };
  if (type === "secret" && raw["default"] !== undefined && raw["default"] !== "")
    return bad(`setting ${key}: a secret has no default, forge.json is not a place for one`);
  const fallback = raw["default"] ?? emptyDefault(spec.type, choices);
  const checked = checkSetting(spec, fallback);
  if (!checked.ok) return bad(`setting ${key}: default ${checked.error}`);
  return ok({ ...spec, default: checked.value });
}

function emptyDefault(type: SettingType, choices: readonly string[] | undefined): unknown {
  switch (type) {
    case "bool":
      return false;
    case "int":
      return 0;
    case "choice":
      return choices?.[0];
    case "days":
    case "list":
      return [];
    case "string":
    case "secret":
      return "";
  }
}

/**
 * A value for a setting, from JSON (`true`, `13`, `["mon","thu"]`) or from a
 * form (`"on"`, `"13"`, `"mon,thu"`), as the forge keeps it: canonical text.
 * `bool` is `true`/`false`; `int` is digits; `days` is the named days in
 * week order, comma-joined; `list` is its items comma-joined. Anything else
 * is refused with why, in words a form can show.
 */
export function checkSetting(spec: Pick<SettingSpec, "type" | "min" | "max" | "choices">, value: unknown): Result<string, string> {
  switch (spec.type) {
    case "bool": {
      if (value === true || value === "true" || value === "on" || value === "1") return ok("true");
      if (value === false || value === "false" || value === "off" || value === "0" || value === "") return ok("false");
      return err("is on or off");
    }
    case "int": {
      const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : NaN;
      if (!Number.isInteger(n) || Math.abs(n) > INT_LIMIT) return err("is a whole number");
      if (spec.min !== undefined && n < spec.min) return err(`is at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) return err(`is at most ${spec.max}`);
      return ok(String(n));
    }
    case "secret":
    case "string": {
      if (typeof value !== "string") return err("is text");
      if (value.length > STRING_MAX) return err(`is at most ${STRING_MAX} characters`);
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) return err("has no control characters");
      return ok(value);
    }
    case "choice": {
      if (typeof value !== "string" || !(spec.choices ?? []).includes(value)) return err(`is one of ${(spec.choices ?? []).join(", ")}`);
      return ok(value);
    }
    case "days": {
      const items = listOf(value);
      if (items === undefined) return err("is a list of days");
      const named = new Set(items.map((d) => d.toLowerCase().slice(0, 3)));
      for (const d of named) if (!(DAYS as readonly string[]).includes(d)) return err(`names days: ${DAYS.join(", ")}`);
      return ok(DAYS.filter((d) => named.has(d)).join(","));
    }
    case "list": {
      const items = listOf(value);
      if (items === undefined) return err("is a list");
      if (items.length > LIST_MAX) return err(`has at most ${LIST_MAX} items`);
      for (const item of items) {
        if (item.length > STRING_MAX || item.includes(",") || /[\u0000-\u001f\u007f]/.test(item))
          return err(`items are text without commas, at most ${STRING_MAX} characters`);
      }
      return ok(items.join(","));
    }
  }
}

/** A list from JSON or from a form's comma- or line-separated text; blanks dropped. */
function listOf(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.every((v) => typeof v === "string") ? (value as string[]).map((v) => v.trim()).filter(Boolean) : undefined;
  if (typeof value === "string") return value.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
  return undefined;
}

/** `runHourUtc` → `FORGE_SETTING_RUN_HOUR_UTC`. */
export function settingEnvName(key: string): string {
  return `FORGE_SETTING_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

/**
 * What an absorbed app's process is told: every declared setting, the kept
 * value or else its default, plus `FORGE_FEATURE=1`. A kept value for a
 * setting the app no longer declares is left out; one that no longer fits
 * its declaration (a narrowed range) falls back to the default.
 */
export function featureEnv(spec: FeatureSpec, kept: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = { FORGE_FEATURE: "1" };
  for (const s of spec.settings) {
    const value = kept.get(s.key);
    const fits = value === undefined ? undefined : checkSetting(s, value);
    out[settingEnvName(s.key)] = fits?.ok ? fits.value : s.default;
  }
  return out;
}
