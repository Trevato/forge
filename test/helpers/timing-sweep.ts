/**
 * The Server-Timing sweep's collection, as a plain function over a fetch
 * (#9500). A worker that throws takes the whole test down with one stack and
 * no route; this one records every page that throws, answers 5xx or leaves
 * out `app`, so a red sweep's log names each route and why.
 */

export type SweepFetch = (path: string, signal: AbortSignal) => Promise<Response>;

export type SweepFailure = { path: string; status: number } | { path: string; error: string };

export interface SweepResult {
  /** HTML pages naming `session` and `render`. */
  named: string[];
  /** HTML pages that answer without `session` or `render`. */
  bare: string[];
  /** Pages that answered 3xx. */
  redirected: string[];
  /** Pages that threw (abort, reset) or answered 5xx. */
  failures: SweepFailure[];
  /** HTML pages whose Server-Timing leaves out `app`, with the header they sent. */
  missingApp: Array<{ path: string; serverTiming: string }>;
}

export interface SweepOptions {
  /** Fetches in flight at once. */
  concurrency?: number;
  /** Abort for one request, so a slow page fails by name, not as a test timeout. */
  perRequestMs?: number;
}

export async function collectTimings(
  paths: readonly string[],
  fetchPage: SweepFetch,
  { concurrency = 4, perRequestMs = 20_000 }: SweepOptions = {},
): Promise<SweepResult> {
  const result: SweepResult = { named: [], bare: [], redirected: [], failures: [], missingApp: [] };
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      let res: Response;
      try {
        res = await fetchPage(path, AbortSignal.timeout(perRequestMs));
        await res.arrayBuffer();
      } catch (e) {
        result.failures.push({ path, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
        continue;
      }
      if (res.status >= 500) {
        result.failures.push({ path, status: res.status });
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        result.redirected.push(path);
        continue;
      }
      if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) continue;
      const serverTiming = res.headers.get("server-timing") ?? "";
      const names = serverTiming.split(",").map((p) => p.trim().split(";")[0]);
      if (!names.includes("app")) {
        result.missingApp.push({ path, serverTiming });
        continue;
      }
      (names.includes("session") && names.includes("render") ? result.named : result.bare).push(path);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  result.failures.sort(byPath);
  result.missingApp.sort(byPath);
  return result;
}
