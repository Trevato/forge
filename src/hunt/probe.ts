/**
 * The hunter's only way to touch an app: GET, never following a redirect on
 * its own. A validator against production must be unable to mutate, so no
 * other method exists here (#5846).
 */

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface Seen {
  path: string;
  status: number;
  location: string | null;
  type: string;
  body: string;
}

export interface Probe {
  get(path: string): Promise<Seen>;
}

/** Same-origin only: a path or an absolute URL on the target's origin. */
export function inside(base: string, href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  return url.pathname + url.search;
}

const BODY_MAX = 400_000;

/** At most BODY_MAX bytes of the body; the rest is never read. */
async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < BODY_MAX) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, BODY_MAX));
}

export function probe(base: string, fetcher: Fetcher = fetch as Fetcher): Probe {
  return {
    async get(path) {
      const target = inside(base, path);
      if (target === null) throw new Error(`refusing a path off the target: ${path}`);
      try {
        const res = await fetcher(new URL(target, base).href, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": "forge-hunter" },
          signal: AbortSignal.timeout(10_000),
        });
        const type = res.headers.get("content-type") ?? "";
        const body = /text|json|xml/.test(type) ? await readBounded(res) : "";
        await res.body?.cancel().catch(() => {});
        return { path: target, status: res.status, location: res.headers.get("location"), type, body };
      } catch {
        // A dead or hung route is a result (status 0), not a crash that loses the pass.
        return { path: target, status: 0, location: null, type: "", body: "" };
      }
    },
  };
}
