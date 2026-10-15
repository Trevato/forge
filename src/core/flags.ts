/**
 * Feature flags (#1827): two versions of a thing side by side, the same
 * person always on the same side.
 *
 * Every flag is declared in `FLAGS` below — name, one line of why, default,
 * owner issue — and `flag(name, viewer)` takes only a declared name, so an
 * undeclared one is a type error. A declared flag no file in `src/` reads is
 * dead weight; `unreadFlags` names it and `test/flags.test.ts` fails on it.
 *
 * A value is a row in `forge_setting` under `flag.<name>`, JSON:
 *   { "forge": true, "users": ["u1"], "roles": ["admin"], "percent": 30 }
 * Every field is optional. A viewer is on when listed in `users`, or their
 * role is in `roles`, or their hash bucket falls under `percent`; otherwise
 * `forge` (when set) answers, otherwise the default. Rows are read once into
 * memory by `loadFlags`; an unset, malformed or unreadable value is the
 * default, so boot never waits on or fails for a flag.
 */

import type { Database } from "bun:sqlite";

export type FlagDecl = {
  /** One line: what the flag switches and why it exists. */
  why: string;
  /** The value when nothing is set. */
  default: boolean;
  /** The issue that owns removing the flag. */
  issue: number;
};

/** Declared flags. None yet: the first one arrives with the thing it guards. */
export const FLAGS = {} as const satisfies Record<string, FlagDecl>;

export type FlagName = keyof typeof FLAGS;

export type Viewer = { id: string; role?: string };

export type FlagValue = {
  forge?: boolean;
  users?: string[];
  roles?: string[];
  percent?: number;
};

const KEY_PREFIX = "flag.";

/** FNV-1a with a final avalanche, so near ids do not land in near buckets. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The viewer's stable bucket for a flag, 0–99. */
export function bucket(name: string, viewerId: string): number {
  return hash32(`${name}:${viewerId}`) % 100;
}

/** Parse a stored value; anything malformed is `undefined`, never a throw. */
export function parseValue(raw: string): FlagValue | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return undefined;
  const o = data as Record<string, unknown>;
  const out: FlagValue = {};
  if (typeof o["forge"] === "boolean") out.forge = o["forge"];
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((s) => typeof s === "string")
      ? (v as string[])
      : undefined;
  const users = strings(o["users"]);
  if (users !== undefined) out.users = users;
  const roles = strings(o["roles"]);
  if (roles !== undefined) out.roles = roles;
  const p = o["percent"];
  if (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 100)
    out.percent = p;
  return out;
}

/** Whether a flag named `name` with `value` is on for `viewer`. */
export function evaluate(
  name: string,
  def: boolean,
  value: FlagValue | undefined,
  viewer: Viewer | undefined,
): boolean {
  if (value === undefined) return def;
  if (viewer !== undefined) {
    if (value.users?.includes(viewer.id)) return true;
    if (viewer.role !== undefined && value.roles?.includes(viewer.role))
      return true;
    if (value.percent !== undefined && bucket(name, viewer.id) < value.percent)
      return true;
  }
  return value.forge ?? def;
}

/** Declared names that no source reads as `flag("name"` (or `'name'`). */
export function unreadFlags(
  names: readonly string[],
  sources: ReadonlyMap<string, string>,
): string[] {
  return names.filter((name) => {
    const read = new RegExp(`\\bflag\\(\\s*["'\`]${name}["'\`]`);
    for (const [file, text] of sources)
      if (file !== "src/core/flags.ts" && read.test(text)) return false;
    return true;
  });
}

/** A flag registry over `decls`; the forge's own is `flag`/`loadFlags` below. */
export function makeFlags<const D extends Record<string, FlagDecl>>(decls: D) {
  let values = new Map<string, FlagValue>();
  return {
    /** Read every stored value once. A failure leaves the defaults. */
    load(db: Database): void {
      try {
        const rows = db
          .query<
            { key: string; value: string },
            [string]
          >("SELECT key, value FROM forge_setting WHERE key LIKE ?1")
          .all(`${KEY_PREFIX}%`);
        const next = new Map<string, FlagValue>();
        for (const row of rows) {
          const name = row.key.slice(KEY_PREFIX.length);
          const parsed = name in decls ? parseValue(row.value) : undefined;
          if (parsed !== undefined) next.set(name, parsed);
        }
        values = next;
      } catch {
        values = new Map();
      }
    },
    flag(name: keyof D & string, viewer?: Viewer): boolean {
      return evaluate(name, decls[name]!.default, values.get(name), viewer);
    },
  };
}

const forgeFlags = makeFlags(FLAGS);

/** Read the stored flag values into memory; never throws. */
export const loadFlags = forgeFlags.load;

/** Whether `name` is on for `viewer` (none: signed out). */
export const flag = forgeFlags.flag;
