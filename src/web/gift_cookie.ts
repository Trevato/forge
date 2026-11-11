/**
 * A gift code in transit (#11157): the link `/?code=` carries it once, then
 * it rides an HttpOnly cookie for an hour so the next URL, the access log and
 * the history never hold it. The new-forge page reads it from here.
 */

import { cookieValue } from "../http/context.ts";
import { secureFor } from "../http/cookie_secure.ts";

const NAME = "forge_gift";
const SHAPE = /^[A-Za-z0-9-]{1,64}$/;

/** A `303` to `to` that keeps the code in a cookie, not in the address. */
export function keepGift(code: string, to: string, url: URL, forgeUrl?: string): Response {
  const secure = secureFor(url, forgeUrl) ? "; Secure" : "";
  const headers = new Headers({ location: to, "cache-control": "no-store" });
  if (SHAPE.test(code)) headers.append("set-cookie", `${NAME}=${code}; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly${secure}`);
  return new Response(null, { status: 303, headers });
}

/** The code a visitor arrived with, or "". */
export function keptGift(request: Request): string {
  const v = cookieValue(request, NAME) ?? "";
  return SHAPE.test(v) ? v : "";
}

/** Sent once the forge is made: the code is spent from the browser too. */
export function dropGift(url: URL, forgeUrl?: string): string {
  const secure = secureFor(url, forgeUrl) ? "; Secure" : "";
  return `${NAME}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
}
