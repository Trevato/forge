/**
 * Devices on the owner's network: the rows, and the one check that decides
 * whether a declared address may be asked at all. A device is a name, a kind
 * (only `printer` for now) and an IPP URL. The URL must name a private-network
 * IP *literal* (RFC 1918, fc00::/7, fe80::/10): a name would be resolved at
 * probe time, and what it resolves to could change after it was checked. So
 * the forge never reaches a public host, and never one it has to look up.
 */

import type { Database } from "bun:sqlite";
import { isPrivateHost } from "../actions/migrate.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { PrinterReport } from "../devices/ipp.ts";

export const DEVICE_KINDS = ["printer"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const NAME_MAX = 60;
export const URL_MAX = 200;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const PATH = /^\/[A-Za-z0-9._~\-/%]*$/;
const SCHEMES: Record<string, string> = { "ipp:": "631", "ipps:": "631", "http:": "80", "https:": "443" };

export type DeviceError =
  | "invalid_name"
  | "invalid_kind"
  | "invalid_url"
  | "public_address"
  | "name_taken"
  | "not_found";

/**
 * Loopback is only for a fake printer in a test or a bench, switched on by
 * `FORGE_DEVICES_ALLOW_LOOPBACK=1`; production never sets it.
 */
const allowLoopback = (): boolean => process.env.FORGE_DEVICES_ALLOW_LOOPBACK === "1";

const isLoopbackLiteral = (h: string): boolean => h.startsWith("127.") || h === "[::1]";

/** Never a printer: the unspecified address, and IPv4 link-local 169.254.0.0/16 (cloud metadata lives there). */
const isNeverLiteral = (h: string): boolean => h === "0.0.0.0" || h === "[::]" || h.startsWith("169.254.");

/** The URL as it will be stored, or why it is refused. */
export function validateDeviceUrl(raw: string): Result<string, DeviceError> {
  if (raw.length === 0 || raw.length > URL_MAX || /[\u0000-\u0020\u007f]/.test(raw)) return err("invalid_url");
  const u = URL.parse(raw);
  if (u === null || !(u.protocol in SCHEMES)) return err("invalid_url");
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return err("invalid_url");
  if (u.port !== "" && !(Number(u.port) >= 1 && Number(u.port) <= 65535)) return err("invalid_url");
  if (!PATH.test(u.pathname) || u.pathname.includes("..")) return err("invalid_url");
  const host = u.hostname; // IPv6 keeps its brackets
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (host.startsWith("[") && host.endsWith("]"));
  if (!literal) return err("public_address"); // a name is never looked up
  if (isNeverLiteral(host)) return err("public_address");
  if (isLoopbackLiteral(host)) return allowLoopback() ? ok(u.toString()) : err("public_address");
  if (!isPrivateHost(host)) return err("public_address");
  return ok(u.toString());
}

export interface Device {
  readonly id: number;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly url: string;
  readonly createdAt: string;
  readonly probe: PrinterReport | null;
  readonly probedAt: string | null;
}

interface Row {
  id: number;
  name: string;
  kind: string;
  url: string;
  created_at: string;
  probe_json: string | null;
  probed_at: string | null;
}

function fromRow(r: Row): Device {
  let probe: PrinterReport | null = null;
  try {
    probe = r.probe_json === null ? null : (JSON.parse(r.probe_json) as PrinterReport);
  } catch {
    probe = null;
  }
  return { id: r.id, name: r.name, kind: r.kind as DeviceKind, url: r.url, createdAt: r.created_at, probe, probedAt: r.probed_at };
}

export function listDevices(db: Database): Device[] {
  return db.query<Row, []>("SELECT * FROM device ORDER BY name").all().map(fromRow);
}

export function getDevice(db: Database, id: number): Device | undefined {
  const r = db.query<Row, [number]>("SELECT * FROM device WHERE id = ?1").get(id);
  return r ? fromRow(r) : undefined;
}

export function declareDevice(
  db: Database,
  input: { name: string; kind: string; url: string },
): Result<Device, DeviceError> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > NAME_MAX || !NAME.test(name)) return err("invalid_name");
  if (!(DEVICE_KINDS as readonly string[]).includes(input.kind)) return err("invalid_kind");
  const url = validateDeviceUrl(input.url.trim());
  if (!url.ok) return url;
  const taken = db.query("SELECT 1 FROM device WHERE name = ?1").get(name);
  if (taken) return err("name_taken");
  const id = Number(db.query("INSERT INTO device (name, kind, url) VALUES (?1, ?2, ?3)").run(name, input.kind, url.value).lastInsertRowid);
  return ok(getDevice(db, id)!);
}

export function removeDevice(db: Database, id: number): Result<true, DeviceError> {
  return db.query("DELETE FROM device WHERE id = ?1").run(id).changes === 0 ? err("not_found") : ok(true);
}

export function keepProbe(db: Database, id: number, report: PrinterReport | null, now = new Date()): void {
  db.query("UPDATE device SET probe_json = ?2, probed_at = ?3 WHERE id = ?1").run(
    id,
    report === null ? null : JSON.stringify(report),
    now.toISOString(),
  );
}

/** How long an answer (or a silence) is trusted before the printer is asked again. */
export const PROBE_FRESH_MS = 30_000;

export const isFresh = (d: Device, now = Date.now()): boolean =>
  d.probedAt !== null && now - Date.parse(d.probedAt) < PROBE_FRESH_MS;
