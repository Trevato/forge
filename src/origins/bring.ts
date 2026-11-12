/**
 * Bring an app whole: the pure half. A pasted link becomes the forge it is on
 * and the repository it names; a connected origin is picked by host; and the
 * variables an app asks for are read, by name only, from the `.env.example`
 * it ships. Nothing here touches the network, the database or a value.
 */

import type { Origin } from "./types.ts";

export interface BringLink {
  /** `host[:port]` of the forge the link points at. */
  readonly host: string;
  /** `owner/name` on that forge. */
  readonly fullName: string;
}

export type BringLinkError = "empty" | "not_a_link" | "not_a_repository";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_LINK = 300;

/**
 * `https://codeberg.org/ana/notes`, `…/ana/notes.git` and deeper pages
 * (`…/tree/main`, `…/pulls/3`) all name the same repository. Only http(s)
 * links, with no credentials in them, are links.
 */
export function parseBringLink(
  text: string,
): { ok: true; value: BringLink } | { ok: false; error: BringLinkError } {
  const raw = text.trim();
  if (raw === "") return { ok: false, error: "empty" };
  if (raw.length > MAX_LINK) return { ok: false, error: "not_a_link" };
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (
    url === null ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  )
    return { ok: false, error: "not_a_link" };
  const [owner, rawName] = url.pathname.split("/").filter((s) => s !== "");
  const name = rawName?.replace(/\.git$/, "");
  if (owner === undefined || name === undefined || !SEGMENT.test(owner) || !SEGMENT.test(name))
    return { ok: false, error: "not_a_repository" };
  return { ok: true, value: { host: url.host.toLowerCase(), fullName: `${owner}/${name}` } };
}

/** The account's connected origin on the link's host, if it has one. */
export function originOnHost(origins: readonly Origin[], host: string): Origin | undefined {
  return origins.find((o) => !o.needsReauth && URL.parse(o.webUrl)?.host.toLowerCase() === host);
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_NEEDS = 40;

/**
 * The variable names in a `.env.example`: `NAME=` lines, `export NAME=`
 * allowed, comments and anything else ignored. Values are dropped at once —
 * an example's values are the author's, never ours to carry.
 */
export function needsOf(example: string): string[] {
  const names: string[] = [];
  for (const line of example.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const name = m?.[1];
    if (name !== undefined && NAME.test(name) && !names.includes(name)) names.push(name);
    if (names.length >= MAX_NEEDS) break;
  }
  return names;
}

/** Words for a token that would travel in clear. */
export const PLAIN_HTTP_WORDS =
  "That link is plain http, and a token sent there travels in clear. Use the https link.";

/**
 * The address to connect for a link: `https:` unless the link itself says
 * `http:`, and then only on a development instance (`FORGE_DEV=1`), because a
 * token is sent to it.
 */
export function connectSite(
  link: string,
  host: string,
  env: Record<string, string | undefined> = process.env,
): { ok: true; value: string } | { ok: false; error: "plain_http" } {
  if (/^http:\/\//i.test(link.trim())) {
    if (env.FORGE_DEV !== "1") return { ok: false, error: "plain_http" };
    return { ok: true, value: `http://${host}` };
  }
  return { ok: true, value: `https://${host}` };
}
