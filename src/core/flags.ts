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
import { quietly } from "./write_clock.ts";

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

/** How many times a flag answered each way. */
export type FlagUses = { on: number; off: number };

/** Fewer reads than this in 30 days are too few to call a winner. */
export const MIN_WINNER_READS = 50;

/** The variant to offer as the default: the 30-day leader, unless it is too few reads, a tie, or already the forge's value. */
export function winnerOffer(uses: FlagUses, current: FlagValue | undefined): "on" | "off" | undefined {
  if (uses.on + uses.off < MIN_WINNER_READS || uses.on === uses.off) return undefined;
  const lead = uses.on > uses.off ? "on" : "off";
  return current?.forge === (lead === "on") ? undefined : lead;
}

/** The read-out line both doors show. */
export function usesLine(week: FlagUses, month: FlagUses): string {
  return `Uses, 7 days: on ${week.on} · off ${week.off} · 30 days: on ${month.on} · off ${month.off}`;
}

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

export type FlagInput = {
  /** "" leaves `forge` unset; "on"/"off" set it. */
  forge: string;
  users: string;
  roles: string;
  percent: string;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_LIST = 200;

function list(text: string, shape: RegExp, what: string) {
  const items = [...new Set(text.split(/[\s,]+/).filter((x) => x !== ""))];
  if (items.length > MAX_LIST) return `Too many ${what}.`;
  const bad = items.find((x) => !shape.test(x));
  return bad === undefined ? items : `"${bad.slice(0, 40)}" is not a valid ${what.replace(/s$/, "")}.`;
}

/**
 * Check form text against the declared type of a flag value (see `FlagValue`)
 * and build it. `undefined` means nothing is set: clear the row.
 */
export function checkInput(
  input: FlagInput,
): { ok: true; value: FlagValue | undefined } | { ok: false; message: string } {
  const out: FlagValue = {};
  if (input.forge === "on") out.forge = true;
  else if (input.forge === "off") out.forge = false;
  else if (input.forge !== "") return { ok: false, message: "forge must be on, off or unset." };
  const users = list(input.users, ID, "user ids");
  if (typeof users === "string") return { ok: false, message: users };
  if (users.length > 0) out.users = users;
  const roles = list(input.roles, ROLE, "roles");
  if (typeof roles === "string") return { ok: false, message: roles };
  if (roles.length > 0) out.roles = roles;
  const pct = input.percent.trim();
  if (pct !== "") {
    if (!/^\d{1,3}$/.test(pct) || Number(pct) > 100)
      return { ok: false, message: "percent is a whole number from 0 to 100." };
    out.percent = Number(pct);
  }
  return { ok: true, value: Object.keys(out).length === 0 ? undefined : out };
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
  // Reads waiting to be written: `day\tflag\tvariant` → count. Counting is a
  // map bump; `flush` writes the lot in one transaction, so a read costs no query.
  let pending = new Map<string, number>();
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
    decls,
    /** The live value of `name`, if one is set. */
    value(name: string): FlagValue | undefined {
      return values.get(name);
    },
    /** Every declared flag with its declaration and live value, in declaration order. */
    entries(): { name: string; decl: FlagDecl; value: FlagValue | undefined }[] {
      return Object.keys(decls).map((name) => ({
        name,
        decl: decls[name]!,
        value: values.get(name),
      }));
    },
    /**
     * Store `value` for a declared flag (`undefined` clears it), keep the
     * change in `forge_setting_change`, and reload so it is live at once.
     */
    set(
      db: Database,
      name: string,
      value: FlagValue | undefined,
      actorId: string,
    ): boolean {
      if (!Object.hasOwn(decls, name)) return false;
      const key = KEY_PREFIX + name;
      const at = new Date().toISOString();
      const show = (v: string | null | undefined) => v ?? "default";
      db.transaction(() => {
        const from = db
          .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
          .get(key)?.value;
        const to = value === undefined ? undefined : JSON.stringify(value);
        if (to === undefined) db.query("DELETE FROM forge_setting WHERE key = ?1").run(key);
        else
          db.query(
            `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value,
               updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          ).run(key, to, actorId, at);
        db.query(
          `INSERT INTO forge_setting_change (key, from_value, to_value, actor_id, at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).run(key, show(from), show(to), actorId, at);
      })();
      this.load(db);
      return true;
    },
    flag(name: keyof D & string, viewer?: Viewer): boolean {
      const on = evaluate(name, decls[name]!.default, values.get(name), viewer);
      const key = `${new Date().toISOString().slice(0, 10)}\t${name}\t${on ? 1 : 0}`;
      pending.set(key, (pending.get(key) ?? 0) + 1);
      return on;
    },
    /** Write the counted reads. A failure keeps them for the next try. */
    flush(db: Database): void {
      if (pending.size === 0) return;
      const taken = pending;
      pending = new Map();
      try {
        const up = db.query(
          `INSERT INTO flag_use (day, flag, variant, n) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (day, flag, variant) DO UPDATE SET n = n + excluded.n`,
        );
        db.transaction(() => quietly(db, () => {
          for (const [key, n] of taken) {
            const [day, flag, variant] = key.split("\t");
            up.run(day!, flag!, Number(variant), n);
          }
        }))();
      } catch {
        for (const [key, n] of taken) pending.set(key, (pending.get(key) ?? 0) + n);
      }
    },
    /** Reads per variant over the last `days` UTC days, today included. */
    uses(db: Database, name: string, days: number, now = new Date()): FlagUses {
      this.flush(db);
      const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const rows = db
        .query<{ variant: number; n: number }, [string, string]>(
          "SELECT variant, SUM(n) AS n FROM flag_use WHERE flag = ?1 AND day >= ?2 GROUP BY variant",
        )
        .all(name, since);
      const out: FlagUses = { on: 0, off: 0 };
      for (const r of rows) out[r.variant === 1 ? "on" : "off"] = r.n;
      return out;
    },
  };
}

const forgeFlags = makeFlags(FLAGS);

/** Read the stored flag values into memory; never throws. */
export const loadFlags = forgeFlags.load;

/** Whether `name` is on for `viewer` (none: signed out). */
export const flag = forgeFlags.flag;

/** Write the counted flag reads; the boot calls it on a timer and at exit. */
export const flushFlagUses = forgeFlags.flush;

/** The forge's registry, for the settings page. */
export const forgeRegistry = forgeFlags;

type Registry = typeof forgeRegistry;
let active: Registry = forgeRegistry;

/** The registry the settings page and the terminal screen read and set. */
export function flagRegistry(): Registry {
  return active;
}

/** Tests swap the registry for one with declared flags; the forge never does. */
export function useFlagRegistry(next: Registry | undefined): void {
  active = next ?? forgeRegistry;
}

/** Whether `user` may see and set flags: an admin who is not an agent. */
export function mayManageFlags(user: { isAdmin: boolean; kind: string } | undefined): boolean {
  return user !== undefined && user.isAdmin && user.kind !== "agent";
}

/** What a person who may not manage flags is told, by the action, the page and the terminal alike. */
export const FLAGS_ADMIN_ONLY = "Flags are set by a forge admin.";
