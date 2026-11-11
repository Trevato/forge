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
  "privacy",
  "pricing",
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
  "boards",
  "contribute",
  "csp-report",
  "deploy-to",
  "pinned",
  "pipeline",
  "events",
  "bring",
  "explore",
  "packs",
  "family",
  "favicon.ico",
  "fleet",
  "flow",
  "front",
  "go",
  "home",
  "hooks",
  "icons",
  "live",
  "login",
  "logout",
  "manifest.webmanifest",
  "opensearch.xml",
  "map",
  "mcp",
  "metrics",
  "contract",
  "data",
  "migrate",
  "mode",
  "new",
  "oauth",
  "og",
  "organizations",
  "now",
  "resilience",
  "maintenance",
  "origins",
  "robots.txt",
  "favicon.ico",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
  "llms.txt",
  "openapi.json",
  "runs",
  "search",
  "settings",
  "plugins",
  "signin",
  "signup",
  "sitemap.xml",
  "releases",
  "releases.json",
  "changelog.atom",
  "explore.atom",
  "sw.js",
  "tell",
  "talk",
  "notes",
  "theme",
  "verify",
  "recover",
  "www",
  "asked",
  "feed",
  "review",
  "claim",
  "first-admin",
  "forges",
  // the forge's own nouns, and the platform's name
  "user",
  "users",
  "org",
  "orgs",
  "repos",
  "git",
  "ssh",
  "status",
  "changelog",
  "displays",
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
  // Latin letters that do not decompose under NFKD, written as the letters
  // they are read as (so Strauß is strauss, not a foreign script)
  ß: "ss", ł: "l", ø: "o", æ: "ae", œ: "oe", đ: "d", ð: "d", þ: "th",
  ı: "i", ŧ: "t", ħ: "h",
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

/** Whether `name` is one of the forge's own words, by skeleton. */
export const isSystemName = (name: string): boolean => SYSTEM.has(skeleton(name));

/** Why a name is reserved: a system word, the crew's, or the owner's. */
export type Reservation = "system" | "agent" | "owner" | "mixed";

/**
 * Words that, beside one of the crew's names, make a name claim to be the
 * crew: "Scout (crew)", "scout-bot". An agent's name alone is an ordinary
 * word a person may well have (Mason, Juniper), so it is the pairing that is
 * refused, not the word.
 */
const ROLE_WORDS = new Set(
  [
    "crew", "agent", "bot", "ai", "official", "staff", "team", "admin",
    "owner", "forge", "moderator", "mod", "support", "steward",
  ].map((w) => skeleton(w)),
);

/** The words of a name, each as its skeleton: "Scout (crew)" is scout, crew. */
const wordsOf = (name: string): string[] =>
  name
    .normalize("NFKD")
    .split(/[^\p{L}\p{N}]+/u)
    .map(skeleton)
    .filter((w) => w !== "");

/**
 * Why `name` is not free for a new claim, or undefined when it is. `self`
 * is the account making the claim: its own name and display name never
 * count against it (an owner may write their own name as a display name).
 */
export function reservedName(
  db: Database,
  name: string,
  self?: string,
  /**
   * A display name is where real names live: it is the owner's only when it
   * is their handle with nothing but honorific words around it ("the real
   * trevato", "Trevato official"), so "Maria Garcia" stays free beside an
   * admin called maria. A username is held to the whole rule.
   */
  as: "username" | "display" = "username",
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
  // A name that carries a protected one inside it: the owner's handle as
  // any word ("trevato (owner)", "trevato-official"), or one of the crew's
  // names beside a word that claims the role ("Scout (crew)").
  const words = wordsOf(name);
  if (words.length > 1) {
    const claimsRole = words.some((w) => ROLE_WORDS.has(w));
    const bare = words.filter((w) => !HONORIFIC_WORDS.has(w));
    for (const holder of holders) {
      const handle = skeleton(holder.username);
      if (handle.length < 3 || !words.includes(handle)) continue;
      if (holder.is_agent !== 1) {
        if (as === "username" || (bare.length === 1 && bare[0] === handle))
          return "owner";
      } else if (claimsRole) return "agent";
    }
  }
  // The same, run together: "trevato2", "trevatoo", "realtrevato",
  // "scoutbot". Trailing digits never make a name someone else's.
  // The digits come off before the fold, which reads 0 as o and 7 as t.
  const run = wordsOf(name.replace(/[0-9]+$/u, "")).join("");
  for (const holder of holders) {
    const handle = skeleton(holder.username);
    if (handle.length < 3) continue;
    if (holder.is_agent === 1) {
      if (runsWithRole(run, handle)) return "agent";
    } else if (ownersRunOn(run, handle)) return "owner";
  }
  return undefined;
}

/**
 * Words that, run on before or after the owner's handle, make a name claim
 * to be them: the role words, and the ways people say "the real one".
 */
const HONORIFIC_WORDS = new Set(
  [
    ...ROLE_WORDS,
    ...["real", "the", "its", "iam", "im", "true", "original", "verified", "hq"].map(
      skeleton,
    ),
  ],
);

/** Whether `run` is `handle` with only `words` run on, either side, any number. */
function bareIs(run: string, handle: string, words: ReadonlySet<string>): boolean {
  if (run === handle) return true;
  for (const w of words) {
    if (run.length <= w.length) continue;
    if (run.startsWith(w) && bareIs(run.slice(w.length), handle, words)) return true;
    if (run.endsWith(w) && bareIs(run.slice(0, -w.length), handle, words)) return true;
  }
  return false;
}

/** A crew name run together with a role word, either way round. */
const runsWithRole = (run: string, handle: string): boolean =>
  bareIs(run, handle, ROLE_WORDS);

/**
 * The owner's handle run on: its last letter doubled ("trevatoo"), or a
 * role or honorific word either side ("realtrevato", "trevatoofficial").
 * Never a longer name that only contains it: an admin called maria leaves
 * mariana and annamaria free.
 */
function ownersRunOn(run: string, handle: string): boolean {
  const last = handle.at(-1)!;
  const tail = run.slice(handle.length);
  if (run.startsWith(handle) && [...tail].every((c) => c === last)) return true;
  return bareIs(run, handle, HONORIFIC_WORDS);
}
