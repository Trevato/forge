import type { Database } from "bun:sqlite";

/**
 * Which columns hold secrets, by rule. A masked cell shows that a value is
 * there and nothing of it. A source may allow a column by name
 * (`table.column`) when its content is known to be harmless.
 */

export const MASK = "••••••";

const SECRET =
  /_enc$|verifier|nonce|challenge|(^|_)code(_hash)?$|token|secret|passw(or)?d|passhash|(^|_)hash$|^hash$|sealed|api_?key|(^|_)key$|^key$|private|credential|cookie|(^|_)salt$|(^|_)sig(nature)?$|^pw/i;

/** Per-source allowlist: source id → `table.column` entries shown in clear. */
export const ALLOW: Record<string, readonly string[]> = {};

/**
 * Per-source columns masked whatever their name: generic ones that hold
 * secrets in some rows (a setting's `value`, a stored response `body`).
 */
export const FORCE: Readonly<Record<string, readonly string[]>> = {
  forge: [
    "forge_setting.value",
    "forge_setting_change.from_value",
    "forge_setting_change.to_value",
    "front_setting.value",
    "user_setting.value",
    "origin_cursor.value",
    "sentinel_kept.value",
    "idempotency.body",
    "event.payload",
    "sentinel_finding.evidence",
  ],
};

export const isSecretColumn = (column: string): boolean => SECRET.test(column);

/** Whether `table.column` of a source shows only the mask. */
export function masker(sourceId: string): (table: string, column: string) => boolean {
  const allow = new Set(ALLOW[sourceId] ?? []);
  const force = new Set(FORCE[sourceId] ?? []);
  return (table, column) => {
    const key = `${table}.${column}`;
    if (allow.has(key)) return false;
    return force.has(key) || SECRET.test(column);
  };
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The masked columns of every table and view in `db`. A view is judged by
 * its text, and masked whole when that text uses `*` (which can pull a
 * secret column without naming it, under any name), names any masked
 * column of the database, or names another view masked whole. So neither
 * an alias, a column list nor a view over a view can launder a secret.
 */
export function maskPlan(db: Database, sourceId: string): Map<string, Set<string>> {
  const masked = masker(sourceId);
  const plan = new Map<string, Set<string>>();
  const objects = db
    .query<{ name: string; type: string; sql: string | null }, []>(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  const columnsOf = (name: string): string[] =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${quote(name)})`)
      .all()
      .map((c) => c.name);
  const secretNames = new Set<string>();
  const cols = new Map<string, string[]>();
  for (const o of objects) {
    const c = columnsOf(o.name);
    cols.set(o.name, c);
    if (o.type === "table")
      plan.set(o.name, new Set(c.filter((x) => masked(o.name, x))));
    for (const x of plan.get(o.name) ?? []) secretNames.add(x.toLowerCase());
  }
  const names = (text: string, name: string): boolean => {
    const n = name.toLowerCase();
    let at = text.indexOf(n);
    while (at >= 0) {
      const before = text[at - 1] ?? " ";
      const after = text[at + n.length] ?? " ";
      if (!/[a-z0-9_$]/.test(before) && !/[a-z0-9_$]/.test(after)) return true;
      at = text.indexOf(n, at + 1);
    }
    return false;
  };
  const views = objects.filter((o) => o.type === "view");
  const text = new Map(views.map((o) => [o.name, (o.sql ?? "").toLowerCase()]));
  // The part after the view's own name and column list: its SELECT.
  const body = (name: string): string => {
    const t = text.get(name)!;
    const as = t.search(/\bas\b/);
    return as >= 0 ? t.slice(as) : t;
  };
  const whole = new Set<string>();
  for (const o of views) {
    const b = body(o.name);
    if (b.includes("*") || [...secretNames].some((n) => names(b, n))) whole.add(o.name);
  }
  // A view over a view masked whole is masked whole, to any depth.
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of views) {
      if (whole.has(o.name)) continue;
      if ([...whole].some((w) => names(body(o.name), w))) {
        whole.add(o.name);
        grew = true;
      }
    }
  }
  for (const o of views) {
    const c = cols.get(o.name)!;
    plan.set(o.name, new Set(whole.has(o.name) ? c : c.filter((x) => masked(o.name, x))));
  }
  return plan;
}

/** Longest text a cell shows; the rest is cut and marked. */
export const CELL_CAP = 1000;

/** A cell as plain JSON-safe data. */
export function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return value;
  if (typeof value === "string")
    return value.length > CELL_CAP ? `${value.slice(0, CELL_CAP)}…` : value;
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  return String(value);
}
