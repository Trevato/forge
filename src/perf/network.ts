/**
 * Who runs an address range, from the forge's own `network` table: name,
 * operator, country and abuse contact, entered by an admin (a registry
 * extract, an RIR whois answer they looked up themselves). A lookup is a
 * local scan of a small table, so no visitor address is sent to anyone.
 *
 * What it says is what the table says. A range with no entry has no network
 * here, and the page says so rather than guess. An entry narrower than a
 * prefix covers only part of it (`scope: "part"`).
 */

import type { Database } from "bun:sqlite";
import { addressBytes, inCidr, parseCidr, type Cidr } from "../kernel/cidr.ts";

export const MAX_IMPORT_LINES = 2_000;

export interface Network {
  readonly cidr: string;
  readonly name: string;
  readonly operator: string;
  readonly country: string;
  readonly abuse: string;
  /** Does the entry cover the whole of what was asked about, or only part of it. */
  readonly scope: "whole" | "part";
}

interface Row {
  cidr: string;
  name: string;
  operator: string;
  country: string;
  abuse: string;
}

export interface NetworkTable {
  /** The most specific entry covering an address or a prefix (`203.0.0.0/16`); null when none does. */
  find(addressOrPrefix: string): Network | null;
  size: number;
}

export function networkTable(db: Database): NetworkTable {
  const rows = db
    .query<Row, []>("SELECT cidr, name, operator, country, abuse FROM network")
    .all()
    .flatMap((r) => {
      const cidr = parseCidr(r.cidr);
      return cidr === undefined ? [] : [{ r, cidr }];
    });
  return {
    size: rows.length,
    find(text) {
      const [base, len] = text.split("/");
      if (base === undefined || addressBytes(base) === undefined) return null;
      const asked = len === undefined ? (addressBytes(base)!.length * 8) : Number(len);
      let best: { r: Row; cidr: Cidr } | undefined;
      for (const e of rows)
        if (inCidr(base, e.cidr) && (best === undefined || e.cidr.bits > best.cidr.bits)) best = e;
      if (best === undefined) return null;
      return { ...best.r, scope: best.cidr.bits <= asked ? "whole" : "part" };
    },
  };
}

const ABUSE = /^(?:[^\s@<>,]{1,64}@[^\s@<>,]{1,120}|https?:\/\/[^\s<>"]{4,200})$/;
const clean = (s: string, max: number): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export interface Imported {
  readonly rows: readonly Omit<Network, "scope">[];
  /** `line N: why`, for each line refused. */
  readonly refused: readonly string[];
}

/** Lines of `range, name, operator, country, abuse contact`; a malformed line is named and skipped, never guessed at. */
export function parseNetworks(text: string): Imported {
  const rows: Omit<Network, "scope">[] = [];
  const refused: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.slice(0, MAX_IMPORT_LINES).forEach((line, i) => {
    if (line.trim() === "" || line.trim().startsWith("#")) return;
    const f = line.split(",").map((x) => x.trim());
    const n = `line ${i + 1}`;
    if (f.length !== 5) return void refused.push(`${n}: want range, name, operator, country, abuse contact`);
    const [cidr, name, operator, country, abuse] = f as [string, string, string, string, string];
    if (parseCidr(cidr) === undefined || !cidr.includes("/")) return void refused.push(`${n}: not a range like 203.0.0.0/16`);
    if (name === "") return void refused.push(`${n}: no network name`);
    if (!/^[A-Za-z]{2}$/.test(country)) return void refused.push(`${n}: country is two letters`);
    if (abuse !== "" && !ABUSE.test(abuse)) return void refused.push(`${n}: abuse contact is an email address or a web address`);
    rows.push({ cidr, name: clean(name, 100), operator: clean(operator, 100), country: country.toUpperCase(), abuse });
  });
  if (lines.length > MAX_IMPORT_LINES) refused.push(`only the first ${MAX_IMPORT_LINES} lines were read`);
  return { rows, refused };
}

export function saveNetworks(db: Database, rows: Imported["rows"], by: string, now: number): void {
  const put = db.query(
    `INSERT INTO network (cidr, name, operator, country, abuse, source, added_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (cidr) DO UPDATE SET name = excluded.name, operator = excluded.operator,
       country = excluded.country, abuse = excluded.abuse, source = excluded.source, added_at = excluded.added_at`,
  );
  db.transaction(() => {
    for (const r of rows) put.run(r.cidr, r.name, r.operator, r.country, r.abuse, `admin ${by}`, now);
  })();
}
