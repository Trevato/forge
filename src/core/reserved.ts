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
  "llms.txt",
  "runs",
  "search",
  "settings",
  "signin",
  "signup",
  "sitemap.xml",
  "sw.js",
  "theme",
  "www",
  "asked",
  // the forge's own nouns, and the platform's name
  "user",
  "users",
  "org",
  "orgs",
  "repos",
  "git",
  "ssh",
  "status",
  "docs",
  "open-platform",
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

/**
 * Letters from other scripts that are drawn like Latin ones (Unicode's
 * confusables, the common part): lowercase Cyrillic and Greek, and Cherokee
 * capitals — which have to be folded before lowercasing turns them into the
 * Cherokee small letters.
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a", б: "b", в: "b", г: "r", д: "d", е: "e", ё: "e", з: "3", и: "u",
  й: "u", к: "k", м: "m", н: "h", о: "o", п: "n", р: "p", с: "c", т: "t",
  у: "y", х: "x", ц: "u", ч: "4", ш: "w", щ: "w", ъ: "b", ы: "bl", ь: "b",
  ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "i",
  // Greek
  α: "a", β: "b", γ: "y", δ: "d", ε: "e", ζ: "z", η: "n", θ: "o", ι: "i",
  κ: "k", λ: "a", μ: "u", ν: "v", ξ: "e", ο: "o", π: "n", ρ: "p", ς: "c",
  σ: "o", τ: "t", υ: "u", φ: "o", χ: "x", ψ: "w", ω: "w",
  // Cherokee capitals (folded before lowercasing)
  Ꭺ: "a", Ᏼ: "b", Ꮯ: "c", Ꭰ: "d", Ꭼ: "e", Ꮐ: "g", Ꮋ: "h", Ꮖ: "i",
  Ꭻ: "j", Ꮶ: "k", Ꮮ: "l", Ꮇ: "m", Ꮑ: "n", Ꮎ: "o", Ꮲ: "p", Ꭱ: "r",
  Ꮪ: "s", Ꭲ: "t", Ꮩ: "v", Ꮃ: "w", Ꮤ: "w", Ꭹ: "y", Ꮓ: "z", Ꮍ: "y",
};

/**
 * A name with its look-alikes folded away: decomposed (NFKD) and its marks
 * stripped (`trevató` is `trevato`), Cyrillic, Greek and Cherokee letters
 * drawn like Latin ones mapped to them, case and separators gone, and digits
 * that pass for letters folded. Any other letter is KEPT, never dropped: a
 * name cannot reach "scout" by hiding a letter the fold does not know.
 */
export function skeleton(name: string): string {
  let out = "";
  const decomposed = name.normalize("NFKD").replace(/\p{M}/gu, "");
  for (const raw of decomposed) {
    const ch = (CONFUSABLE[raw] ?? raw).toLowerCase();
    const mapped = CONFUSABLE[ch] ?? ch;
    for (const c of mapped) {
      if (c in LOOKALIKE) out += LOOKALIKE[c];
      else if (/[a-z0-9]/.test(c)) out += c;
      else if (/\p{L}/u.test(c)) out += c;
    }
  }
  return out;
}

/**
 * Whether a name mixes Latin letters with letters of another script that the
 * fold does not know. Such a mix is how a look-alike the table has not met
 * yet would pass, so it is refused outright; a name wholly in one script
 * (`张伟`, `Ada`) is fine.
 */
export function mixedScript(name: string): boolean {
  const shape = skeleton(name);
  return /[a-z]/.test(shape) && /[^a-z0-9]/.test(shape);
}

const SYSTEM = new Set(SYSTEM_NAMES.map(skeleton));

/** Why a name is reserved: a system word, the crew's, or the owner's. */
export type Reservation = "system" | "agent" | "owner" | "mixed";

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
  if (mixedScript(name)) return "mixed";
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
