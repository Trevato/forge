/**
 * Who a request is, for the returning-visitor view (#11265). Plain data in,
 * plain data out; no SQL here.
 *
 * The primary signal is a random id in a first-party cookie (`forge_visitor`):
 * exact, signed so only this forge's own ids are accepted, and it carries nothing about the person. Without it the fallback is a
 * salted hash of coarse facts the server already sees (browser family and
 * major version, OS, language, the network prefix: /24 for v4, /48 for v6),
 * marked "probable" wherever it is shown and never merged with a cookie id.
 * The salt rotates every 30 days (`visitor_store.ts`). Nothing is probed on the
 * client: no canvas, fonts, audio or WebGL.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "../kernel/hash.ts";
import { addressBytes } from "../kernel/cidr.ts";

export const COOKIE = "forge_visitor";
/** 13 months, in seconds. */
export const COOKIE_MAX_AGE = 396 * 86_400;
export const SALT_MS = 30 * 86_400_000;
const COOKIE_ID = /^c[0-9a-f]{32}\.[0-9a-f]{32}$/;

export type VisitorKind = "cookie" | "probable";

const macOf = (key: Uint8Array, id: string): string => createHmac("sha256", key).update(`visitor-cookie\0${id}`).digest("hex").slice(0, 32);

/**
 * A new random id and the cookie value that carries it: `c<128 random bits>.<32 hex of an HMAC of the id>`.
 * Only a value this forge signed is accepted back (`cookieId`), so a client cannot invent ids to fill the table.
 */
export function mintId(key: Uint8Array): { readonly id: string; readonly value: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = `c${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return { id, value: `${id}.${macOf(key, id)}` };
}

/** The id in a cookie header, only if its signature is one this forge made. */
export function cookieId(header: string | null, key: Uint8Array): string | undefined {
  if (header === null) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    if (!COOKIE_ID.test(value)) return undefined;
    const [id, mac] = value.split(".") as [string, string];
    return timingSafeEqual(Buffer.from(mac), Buffer.from(macOf(key, id))) ? id : undefined;
  }
  return undefined;
}

/** `Sec-GPC: 1` or `DNT: 1`: no cookie and no stored visitor. */
export const refusesTracking = (headers: Headers): boolean =>
  headers.get("sec-gpc") === "1" || headers.get("dnt") === "1";

/** Browser family and major version: "chrome/120". Order matters: Edge and Opera also say Chrome. */
export function browserOf(agent: string): string {
  const a = agent.slice(0, 300);
  const pick = (name: string, re: RegExp): string | undefined => {
    const m = re.exec(a);
    return m === null ? undefined : `${name}/${m[1]}`;
  };
  return (
    pick("edge", /\bEdg(?:e|A|iOS)?\/(\d+)/) ??
    pick("opera", /\bOPR\/(\d+)/) ??
    pick("firefox", /\b(?:Firefox|FxiOS)\/(\d+)/) ??
    pick("chrome", /\b(?:Chrome|CriOS)\/(\d+)/) ??
    pick("safari", /\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//) ??
    "other"
  );
}

export function osOf(agent: string): string {
  const a = agent.slice(0, 300);
  if (/Windows/.test(a)) return "windows";
  if (/Android/.test(a)) return "android";
  if (/iPhone|iPad|iPod/.test(a)) return "ios";
  if (/Mac OS X|Macintosh/.test(a)) return "macos";
  if (/CrOS/.test(a)) return "chromeos";
  if (/Linux|X11/.test(a)) return "linux";
  return "other";
}

/** The first language tag, lowercase, at most 8 characters. */
export const languageOf = (header: string | null): string =>
  (header ?? "").split(",")[0]?.split(";")[0]?.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8) ?? "";

/** The network prefix: /24 of a v4 address, /48 of a v6 one; "" when the address is unknown. */
export function prefixOf(address: string): string {
  const bytes = addressBytes(address);
  if (bytes === undefined) return "";
  if (bytes.length === 4) return `${bytes[0]}.${bytes[1]}.${bytes[2]}/24`;
  return `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}:${((bytes[4]! << 8) | bytes[5]!).toString(16)}/48`;
}

/** The probable id: "p" and a salted hash of the coarse facts. The salt is the 30-day one. */
export function probableId(salt: string, headers: Headers, address: string): string {
  const agent = headers.get("user-agent") ?? "";
  const facts = [browserOf(agent), osOf(agent), languageOf(headers.get("accept-language")), prefixOf(address)].join("\0");
  return `p${sha256(`${salt}\0visitor\0${facts}`).slice(0, 32)}`;
}

/** The Set-Cookie line for a new id: HttpOnly, Secure when the forge is https, SameSite=Lax, 13 months, this host only (no Domain). */
export const cookieLine = (value: string, secure: boolean): string =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`;

/** How far a visitor got; the highest step seen is kept. */
export const STEPS = ["none", "saw plans", "clicked a plan", "started a forge", "paid"] as const;

/** The step a page view shows: the front page and /agents show the plans; a plan chosen is a spawn or a code. */
export function stepOf(route: string, search: string | undefined): number {
  if (route.startsWith("/spawn") || route.startsWith("/signup") || /(?:^|[?&])(?:code|plan)=/.test(search ?? "")) return 2;
  if (route === "/" || route === "/agents" || route === "/plans") return 1;
  return 0;
}
