/**
 * Where a tell came from. A tell said inside an app or a harness carries
 * the page it was said on, the run and commit that were current, and the
 * person's own words, so the agent that picks it up sees its context. Each
 * field is checked at the boundary and bounded; what passes is appended to
 * the tell as a plain block the issue shows and the agent reads.
 */

export interface TellContext {
  readonly page?: string;
  readonly pull?: number;
  readonly run?: string;
  readonly commit?: string;
  readonly said?: string;
}

const SAID_MAX = 2000;
const RUN = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

/**
 * Query parameter names that carry a secret: sign-in, invite and reset
 * links. A name is compared lowercased with `-` read as `_`, so `API-Key`
 * is `api_key`; besides these, any name ending `_token`, `_secret` or `_key`
 * (`id_token`, `client_secret`, `x_api_key`) carries one too.
 */
const SECRET_PARAMS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "code",
  "sig",
  "signature",
  "invite",
  "reset",
  "session",
  "sessionid",
  "sid",
  "auth",
  "authorization",
  "jwt",
  "otp",
  "magic",
  "ticket",
]);
const SECRET_SUFFIX = /_(?:token|secret|key)$/;

/** Whether a query parameter's (still encoded) name carries a secret. */
function secretName(raw: string): boolean {
  let name = raw.replace(/\+/g, " ");
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape is compared as written.
  }
  const n = name.trim().toLowerCase().replace(/-/g, "_");
  return SECRET_PARAMS.has(n) || SECRET_SUFFIX.test(n);
}

/**
 * A query string (with or without its leading `?`) without the parameters
 * that carry a secret. The others keep their order and their exact
 * spelling; a query with nothing to drop comes back as it was given.
 * Out of scope: `;`-separated parameters (read as part of one `&` segment)
 * and secrets in the path itself (`/reset/<token>`), which a pure function
 * of the string cannot tell from an ordinary path.
 */
export function scrubQuery(query: string): string {
  const lead = query.startsWith("?") ? "?" : "";
  const body = query.slice(lead.length);
  if (body === "") return query;
  const parts = body.split("&");
  const kept = parts.filter((part) => !secretName(part.split("=", 1)[0]!));
  if (kept.length === parts.length) return query;
  return kept.length === 0 ? "" : `${lead}${kept.join("&")}`;
}

/** The checked context, nothing for none, or null when a field is malformed. */
export function parseContext(v: unknown): TellContext | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: { page?: string; pull?: number; run?: string; commit?: string; said?: string } = {};
  if (o["page"] !== undefined) {
    const url =
      typeof o["page"] === "string" && o["page"].length <= 2000
        ? URL.parse(o["page"])
        : null;
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:"))
      return null;
    // A fragment holds client-only state (tokens, invite keys); the issue
    // body may be public, so it never travels.
    url.hash = "";
    // Nor do the credentials of a sign-in, invite or reset link.
    url.username = "";
    url.password = "";
    url.search = scrubQuery(url.search);
    out.page = url.href;
  }
  if (o["pull"] !== undefined) {
    const n = o["pull"];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return null;
    out.pull = n;
  }
  if (o["run"] !== undefined) {
    if (typeof o["run"] !== "string" || !RUN.test(o["run"])) return null;
    out.run = o["run"];
  }
  if (o["commit"] !== undefined) {
    if (typeof o["commit"] !== "string" || !COMMIT.test(o["commit"])) return null;
    out.commit = o["commit"];
  }
  if (o["said"] !== undefined) {
    if (typeof o["said"] !== "string" || o["said"].length > SAID_MAX) return null;
    out.said = o["said"].trim();
  }
  return out;
}

/** The block appended to a tell; empty when there is nothing to say. */
export function contextNote(c: TellContext | undefined): string {
  if (c === undefined) return "";
  const lines = [
    c.page === undefined ? "" : `- page: ${c.page}`,
    c.pull === undefined ? "" : `- pull: #${c.pull}`,
    c.run === undefined ? "" : `- run: ${c.run}`,
    c.commit === undefined ? "" : `- commit: ${c.commit}`,
    c.said === undefined || c.said === ""
      ? ""
      : `- their words: ${c.said.replace(/\s*\n\s*/g, " ")}`,
  ].filter((l) => l !== "");
  return lines.length === 0 ? "" : `\n\n---\nWhere this was told from:\n${lines.join("\n")}`;
}
