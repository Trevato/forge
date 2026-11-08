/**
 * Where a new issue was started from. The menu link and the `c` key carry
 * the page they were pressed on as `?from=/path`; the compose
 * form keeps it in a hidden field and the issue ends with one line naming it.
 * A path on this forge only: anything else is dropped at the boundary.
 */

const MAX_FROM = 200;
const SAFE_PATH = /^\/[A-Za-z0-9/._~%-]*$/;

/** The path when it is a plain same-origin path, else undefined. */
export function cleanFrom(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_FROM) return undefined;
  // Only the characters of a path: it is stored in a markdown body, so no
  // brackets, parentheses, backticks, angle brackets or `#` may get in.
  if (!SAFE_PATH.test(raw) || raw.startsWith("//")) return undefined;
  return raw;
}

/** The menu link and the `c` key: the picker/redirect door, naming the page it was pressed on. */
export function newIssueHref(pathname: string): string {
  const from = cleanFrom(pathname);
  return from === undefined || from.startsWith("/new/issue")
    ? "/new/issue"
    : `/new/issue?from=${encodeURIComponent(from)}`;
}

/** The body with the line naming the page it came from, when there is one. */
export function withFromLine(body: string, from: string | undefined): string {
  if (from === undefined) return body;
  const line = `Opened from \`${from}\``;
  return body.trim() === "" ? line : `${body.replace(/\s+$/, "")}\n\n${line}`;
}

/** The repository a path belongs to, as `[owner, name]`, when it has the shape of one. */
export function repoOfPath(from: string): [string, string] | undefined {
  const [owner, name] = from.split("?")[0]!.split("/").filter((s) => s !== "");
  return owner !== undefined && name !== undefined ? [owner, name] : undefined;
}
