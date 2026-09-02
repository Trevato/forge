/**
 * Flash messages: the missing half of post-redirect-get. A mutation sets a
 * short-lived cookie, the next page renders it exactly once as a `.toast` and
 * clears it. No JavaScript, no session storage, no state that outlives one
 * navigation — so a successful POST and a silently-failed one stop looking
 * identical.
 *
 * A flash may also carry a `code`: a value shown exactly once and never
 * again (a fresh token, a webhook signing secret). It rides the same cookie,
 * which is HttpOnly and expires in a minute.
 */

import { cookieValue } from "../http/context.ts";

export const FLASH_COOKIE = "forge_flash";

export interface Flash {
  tone?: "success" | "danger" | "attn";
  message: string;
  /** A one-time value rendered in a copyable monospace block. */
  code?: string;
}

// Cookies cap out around 4KB; a flash is a sentence, not a payload.
const MAX_FLASH = 2000;

/** The `Set-Cookie` value that carries a flash to the next request. */
export function flashCookie(flash: Flash, url?: URL): string {
  const encoded = encodeURIComponent(JSON.stringify(flash)).slice(0, MAX_FLASH);
  const secure = url?.protocol === "https:" ? "; Secure" : "";
  return `${FLASH_COOKIE}=${encoded}; Path=/; Max-Age=60; SameSite=Lax; HttpOnly${secure}`;
}

/** The `Set-Cookie` value that clears it, sent with the page that showed it. */
export function clearFlashCookie(url?: URL): string {
  const secure = url?.protocol === "https:" ? "; Secure" : "";
  return `${FLASH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
}

/**
 * Read a flash off a request. Anything malformed is dropped silently — a
 * corrupt cookie is a nuisance, never an error page, and never markup.
 */
export function readFlash(request: Request): Flash | undefined {
  const raw = cookieValue(request, FLASH_COOKIE);
  if (raw === undefined || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = parsed as Record<string, unknown>;
  if (typeof value.message !== "string" || value.message === "")
    return undefined;
  const tone = value.tone;
  return {
    message: value.message.slice(0, MAX_FLASH),
    ...(tone === "success" || tone === "danger" || tone === "attn"
      ? { tone }
      : {}),
    ...(typeof value.code === "string" && value.code !== ""
      ? { code: value.code.slice(0, 512) }
      : {}),
  };
}
