/**
 * Names nobody new may take. An account's name, and the display name beside
 * it, are how a person tells who is speaking — so a newcomer may not arrive
 * as the crew, as the forge's owner, as the forge itself, or as one of the
 * forge's own pages (`/settings` is a page, never a profile).
 *
 * Names are compared by their skeleton: case, separators and the digits that
 * pass for letters are folded away, so `Sc0ut` and `s-cout` are `scout`.
 * The rule applies to new claims only. An account that already holds a name
 * keeps it; reserving a word later never locks anyone out.
 */

import type { Database } from "bun:sqlite";

/**
 * The forge's own words: system identities, the addresses a mail system
 * reserves, and every top-level page the web router serves (a test holds
 * this list to the router, so a new page cannot slip past it).
 */
export const SYSTEM_NAMES: readonly string[] = [
  // identities
  "admin",
  "administrator",
  "root",
  "system",
  "sysadmin",
  "superuser",
  "owner",
  "staff",
  "official",
  "moderator",
  "plat",
  "platform",
  "forge",
  "crew",
  "agent",
  "agents",
  "bot",
  "steward",
  "anonymous",
  "everyone",
  "nobody",
  "null",
  "undefined",
  // mail and trust
  "support",
  "security",
  "help",
  "abuse",
  "postmaster",
  "hostmaster",
  "webmaster",
  "noreply",
  "no-reply",
  "info",
  "contact",
  // the forge's own pages
  "api",
  "apps",
  "asks",
  "assets",
  "audit",
  "audit.csv",
  "big",
  "board",
  "events",
  "explore",
  "fleet",
  "go",
  "icons",
  "live",
  "login",
  "logout",
  "manifest.webmanifest",
  "map",
  "mcp",
  "migrate",
  "mode",
  "new",
  "oauth",
  "organizations",
  "origins",
  "robots.txt",
  "runs",
  "search",
  "settings",
  "signin",
  "signup",
  "sitemap.xml",
  "sw.js",
  "theme",
  "www",
];

/**
 * Characters that read as one another, folded to one shape before comparing:
 * digits that pass for letters, and `l`, `1` and `i`, which most fonts
 * barely tell apart.
 */
const LOOKALIKE: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  l: "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
};

/** A name with case, separators and look-alike digits folded away. */
export function skeleton(name: string): string {
  let out = "";
  for (const ch of name.normalize("NFKC").toLowerCase()) {
    if (ch in LOOKALIKE) out += LOOKALIKE[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
  }
  return out;
}

const SYSTEM = new Set(SYSTEM_NAMES.map(skeleton));

/** Why a name is reserved: a system word, the crew's, or the owner's. */
export type Reservation = "system" | "agent" | "owner";

/**
 * Why `name` is not free for a new claim, or undefined when it is. `self`
 * is the account making the claim: its own name and display name never
 * count against it (an owner may write their own name as a display name).
 */
export function reservedName(
  db: Database,
  name: string,
  self?: string,
): Reservation | undefined {
  const shape = skeleton(name);
  if (shape === "") return undefined;
  if (SYSTEM.has(shape)) return "system";
  const holders = db
    .query<
      { username: string; display_name: string; is_agent: number },
      [string]
    >(
      `SELECT username, display_name, is_agent FROM user
       WHERE (is_agent = 1 OR (is_admin = 1 AND kind = 'user')) AND id != ?1`,
    )
    .all(self ?? "");
  for (const holder of holders) {
    const names = [holder.username, holder.display_name].filter(
      (n) => n !== "",
    );
    if (names.some((n) => skeleton(n) === shape))
      return holder.is_agent === 1 ? "agent" : "owner";
  }
  return undefined;
}
