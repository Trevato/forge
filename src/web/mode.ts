/**
 * Two ways of seeing one forge. Studio is the default: apps are the unit,
 * and a person tells the crew, looks at what it made, and decides when it
 * asks. Dev shows the git underneath — code, commits, branches, runs —
 * unchanged. The choice is a cookie on this browser, like the theme; the
 * URLs are the same in both, so a link works whichever way its reader sees.
 */

export type Mode = "studio" | "dev";

export const isMode = (value: unknown): value is Mode =>
  value === "studio" || value === "dev";

export const DEFAULT_MODE: Mode = "studio";

export function modeCookie(mode: Mode | undefined, secure: boolean): string {
  const flags = `Path=/; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
  return mode === undefined
    ? `forge_mode=; Max-Age=0; ${flags}`
    : `forge_mode=${mode}; Max-Age=31536000; ${flags}`;
}
