/**
 * What a forge shows anyone, counted through its public API: repositories
 * from `/api/v1/repos` page by page, apps from `/api/v1/apps`, asked with
 * no session. The restore drill script asks a restored forge and
 * production the same way, so the two numbers cover the same rows.
 *
 * `except` leaves out one owner's rows: a restored forge boots as a
 * preview, which seeds the preview admin's sample repository on top of
 * what was restored, and that is not production's.
 */

export interface PublicCounts {
  readonly repositories: number;
  readonly apps: number;
}

/** A forge answers more pages than this only if it is lying about its cursor. */
const MAX_PAGES = 1_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function page(fetcher: Fetch, url: string): Promise<{ items: unknown[]; next: string | null }> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { items?: unknown; next_cursor?: unknown } | null;
  if (body === null || !Array.isArray(body.items)) throw new Error(`${url} answered no items`);
  const next = body.next_cursor;
  return {
    items: body.items,
    next: typeof next === "string" || typeof next === "number" ? String(next) : null,
  };
}

/** The owner of a repository item (`ownerName`) or an app item (`repo.owner`). */
function ownerOf(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const o = item as { ownerName?: unknown; repo?: { owner?: unknown } };
  const name = typeof o.ownerName === "string" ? o.ownerName : o.repo?.owner;
  return typeof name === "string" ? name : undefined;
}

async function countAll(fetcher: Fetch, base: string, path: string, except: string | undefined): Promise<number> {
  let n = 0;
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(path, base);
    url.searchParams.set("limit", "100");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const got = await page(fetcher, url.href);
    n += got.items.filter((item) => except === undefined || ownerOf(item) !== except).length;
    if (got.next === null || got.items.length === 0) return n;
    cursor = got.next;
  }
  throw new Error(`${path} on ${base} pages past ${MAX_PAGES}`);
}

export async function publicCounts(
  base: string,
  options: { readonly except?: string | undefined; readonly fetcher?: Fetch | undefined } = {},
): Promise<PublicCounts> {
  const fetcher = options.fetcher ?? fetch;
  return {
    repositories: await countAll(fetcher, base, "/api/v1/repos", options.except),
    apps: await countAll(fetcher, base, "/api/v1/apps", options.except),
  };
}
