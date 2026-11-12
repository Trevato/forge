/**
 * The external system this adapter reads from, and the only door to it.
 *
 * `SOURCE.hosts` must match `egress` in forge.json: egress is what the
 * forge's proxy opens, and this list is what the adapter itself agrees to
 * reach. `sourceFetch` refuses any other host before a byte leaves the
 * process, so a redirect, a bad config or a cursor that smuggles a URL
 * cannot point the adapter somewhere else.
 *
 * To adapt a real system: change `SOURCE`, the URL in `readPage` and
 * `parseRecord`. Keep the shape: plain data in, plain data out.
 */

export const SOURCE = {
  name: "Example CRM",
  hosts: ["api.example.com"],
} as const;

/** One record as the source gives it, keyed by the source's own id. */
export interface SourceRecord {
  readonly id: string;
  readonly body: string;
}

/** One page of the source: its records and the cursor after them. */
export interface Page {
  readonly records: readonly unknown[];
  readonly cursor: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Thrown when the adapter is asked to reach a host it did not declare. */
export class RefusedHost extends Error {
  constructor(readonly host: string) {
    super(`refused: ${host} is not a declared source host`);
  }
}

/**
 * `fetch`, limited to `https` and the declared hosts. Redirects are not
 * followed: a 3xx is returned as it is, so it cannot lead elsewhere.
 */
export function sourceFetch(
  hosts: readonly string[] = SOURCE.hosts,
  inner: Fetch = fetch,
): Fetch {
  return (url, init) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(new RefusedHost(String(url).slice(0, 100)));
    }
    if (parsed.protocol !== "https:" || !hosts.includes(parsed.hostname))
      return Promise.reject(new RefusedHost(parsed.host));
    return inner(parsed.href, { ...init, redirect: "manual" });
  };
}

/** A cursor is one printable line of at most 200 characters (docs/ADAPTERS.md). */
export function isCursor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[\x20-\x7e]*$/.test(value);
}

/** A record the adapter can keep, or `undefined` for one it cannot. */
export function parseRecord(raw: unknown): SourceRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id } = raw as { id?: unknown };
  if (typeof id !== "string" || id === "" || id.length > 200) return undefined;
  return { id, body: JSON.stringify(raw) };
}

/** Read the page after `cursor` from the source. */
export async function readPage(cursor: string, get: Fetch = sourceFetch()): Promise<Page> {
  const url = `https://${SOURCE.hosts[0]}/records?after=${encodeURIComponent(cursor)}`;
  const answer = await get(url, { headers: { accept: "application/json" } });
  if (!answer.ok) throw new Error(`source answered ${answer.status}`);
  const body: unknown = await answer.json();
  if (typeof body !== "object" || body === null) throw new Error("source page is not an object");
  const { records, cursor: next } = body as { records?: unknown; cursor?: unknown };
  if (!Array.isArray(records)) throw new Error("source page has no records list");
  if (!isCursor(next)) throw new Error("source page cursor is not one printable line");
  return { records, cursor: next };
}
