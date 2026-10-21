/**
 * Lineage: what a pasted repository address forks, asked of its host once,
 * anonymously, for the migrated-from line (#3293). GitHub answers at
 * `api.github.com/repos/:owner/:name` with `parent` (what it forks) and
 * `source` (the root of the network); Forgejo and Gitea answer at
 * `/api/v1/repos/:owner/:name` with `parent`. Any other host, a private
 * repository, a timeout or a strange answer is the same outcome: no chain.
 * It is a nicety, never a reason a migration fails.
 *
 * Written like every fetch of a host a person named (`discover.ts`): the
 * address is vetted (`outboundFetch` refuses a private one and follows no
 * redirect), the wait is short and the body is capped.
 */

import { cleanParents, isFullName } from "../core/provenance.ts";
import { outboundFetch, type OutboundOptions } from "../kernel/outbound.ts";
import { asString, dig, readCapped } from "./providers/http.ts";

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 256 * 1024;

/** The API address that describes the repository at `url`, or `undefined` when it does not name one. */
export function lineageApiUrl(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (parsed === null) return undefined;
  const parts = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((s) => s !== "");
  if (parts.length !== 2 || !isFullName(parts.join("/"))) return undefined;
  const [owner, name] = parts;
  return parsed.hostname.toLowerCase() === "github.com"
    ? `https://api.github.com/repos/${owner}/${name}`
    : `${parsed.origin}/api/v1/repos/${owner}/${name}`;
}

/** The fork chain the host reports, nearest first — `[]` for anything else. */
export function lineageFrom(body: unknown, self: string): string[] {
  return cleanParents(
    [
      asString(dig(body, "parent", "full_name")),
      asString(dig(body, "source", "full_name")),
    ],
    self,
  );
}

export async function lookupLineage(
  url: string,
  options: OutboundOptions = {},
): Promise<string[]> {
  const api = lineageApiUrl(url);
  if (api === undefined) return [];
  try {
    const response = await outboundFetch(
      api,
      {
        headers: { accept: "application/json", "user-agent": "forge-migrate" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      options,
    );
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return [];
    }
    const text = await readCapped(response, MAX_BYTES);
    if (text === undefined) return [];
    const body: unknown = JSON.parse(text);
    return lineageFrom(body, asString(dig(body, "full_name")));
  } catch {
    return [];
  }
}
