/**
 * Private egress grants (#3432): the site admin's yes to one private
 * destination, `host:port`, for one repository's cells. A repository asks in
 * `forge.json` `egress`; only a grant here makes `apps/egress.ts` connect.
 * A destination is exact: a grant on :8101 opens :8101 and nothing else.
 */

import type { Database } from "bun:sqlite";
import { isIP } from "node:net";
import { inCidrs, parseCidrs, type Cidr } from "../kernel/cidr.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface EgressGrant {
  readonly repoId: string;
  readonly destination: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

/**
 * Never grantable: this machine, link-local (the node's metadata service,
 * 169.254.169.254) and the forge's own pod and service ranges — the common
 * cluster defaults, plus `FORGE_NEVER_GRANT_CIDRS` (comma-separated) for
 * the ranges of this cluster.
 */
const ALWAYS_REFUSED = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "10.42.0.0/16",
  "10.43.0.0/16",
  "10.244.0.0/16",
  "10.96.0.0/12",
  "::1",
  "fe80::/10",
];

function refusedRanges(): Cidr[] {
  const extra = process.env["FORGE_NEVER_GRANT_CIDRS"]?.trim();
  const all = [...ALWAYS_REFUSED, ...(extra ? [extra] : [])];
  const parsed = parseCidrs(all.join(","));
  // A malformed operator range must not drop the built-in ones.
  if (parsed.ok) return parsed.value;
  const builtin = parseCidrs(ALWAYS_REFUSED.join(","));
  return builtin.ok ? builtin.value : [];
}

/** Whether an address can never be granted (also checked at connect). */
export function neverGrantable(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return inCidrs(mapped?.[1] ?? address, refusedRanges());
}

/**
 * The curated payment hosts, each named exactly, on 443 (#11142): the
 * ceiling a child forge's cell may open (`children.paymentEgress`), and
 * never let through by report mode in any cell, only by an app's own
 * `forge.json` `egress`.
 */
export const PAYMENT_HOSTS: readonly string[] = ["api.stripe.com:443"];

const NAME_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface Destination {
  readonly host: string;
  readonly port: number;
  readonly text: string;
}

/** `host:port` exactly (IPv4 or a name, port 1-65535), lowercased; or why not. */
export function parseDestination(text: string): Result<Destination, string> {
  const at = text.lastIndexOf(":");
  const host = text.slice(0, at).toLowerCase().replace(/\.$/, "");
  const port = text.slice(at + 1);
  if (at < 1 || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)
    return err(
      "a grant names one destination with its port, like 100.89.95.68:8101",
    );
  if (host.length > 253 || (isIP(host) !== 4 && !NAME_RE.test(host)))
    return err(
      "a grant names an exact IPv4 address or host name, " +
        "not a range or a wildcard",
    );
  return ok({ host, port: Number(port), text: `${host}:${port}` });
}

export function grantEgress(
  db: Database,
  repoId: string,
  destination: string,
  admin: { id: string; isAdmin: boolean },
): Result<EgressGrant, string> {
  if (!admin.isAdmin) return err("only a site admin grants egress");
  const parsed = parseDestination(destination);
  if (!parsed.ok) return parsed;
  const { host, text } = parsed.value;
  if (isIP(host) === 4 && neverGrantable(host))
    return err(
      `${host} can never be granted: it is this machine, link-local ` +
        "or the forge's own cluster",
    );
  if (!db.query("SELECT 1 FROM repo WHERE id = ?1").get(repoId))
    return err("no such repository");
  db.query(
    `INSERT INTO egress_grant (repo_id, destination, granted_by)
     VALUES (?1, ?2, ?3) ON CONFLICT(repo_id, destination) DO NOTHING`,
  ).run(repoId, text, admin.id);
  const row = db
    .query<{ granted_by: string; granted_at: string }, [string, string]>(
      `SELECT granted_by, granted_at FROM egress_grant
       WHERE repo_id = ?1 AND destination = ?2`,
    )
    .get(repoId, text);
  return ok({
    repoId,
    destination: text,
    grantedBy: row?.granted_by ?? admin.id,
    grantedAt: row?.granted_at ?? "",
  });
}

/** Take a grant back; true when there was one. */
export function revokeEgress(
  db: Database,
  repoId: string,
  destination: string,
  admin: { isAdmin: boolean },
): boolean {
  if (!admin.isAdmin) return false;
  const parsed = parseDestination(destination);
  if (!parsed.ok) return false;
  return (
    db
      .query(
        "DELETE FROM egress_grant WHERE repo_id = ?1 AND destination = ?2",
      )
      .run(repoId, parsed.value.text).changes > 0
  );
}

export function listEgressGrants(db: Database, repoId: string): EgressGrant[] {
  return db
    .query<
      { destination: string; granted_by: string; granted_at: string },
      [string]
    >(
      `SELECT destination, granted_by, granted_at FROM egress_grant
       WHERE repo_id = ?1 ORDER BY destination`,
    )
    .all(repoId)
    .map((r) => ({
      repoId,
      destination: r.destination,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    }));
}
