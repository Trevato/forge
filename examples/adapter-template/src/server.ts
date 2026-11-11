/**
 * The adapter's HTTP face:
 *
 *   POST /pull   one pull, for an admin only; answers {pulled, skipped, cursor, errors}
 *   GET  /       the adapter's name; to an admin, also its cursor and counts
 *   GET  /healthz
 *
 * Who is asking comes from the forge's signed headers (`who.ts`): a pull
 * reaches out to the source and writes, so only an `admin` (one who may
 * write the app's repository) may start one. Anyone else is refused before
 * the source is read.
 *
 * The forge hands the process `PORT`, `FORGE_APP_DATA` and
 * `FORGE_APP_IDENTITY_KEY` (docs/APPS.md). Without the key nobody is an
 * admin, so every pull is refused. Zero dependencies; `bun run src/server.ts`.
 */

import { pull, type PullResult } from "./pull.ts";
import { readPage, SOURCE, type Page } from "./source.ts";
import { openStore, type Store } from "./store.ts";
import { who } from "./who.ts";

const HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, "content-type": "application/json" },
  });

/**
 * A mutation from a browser must come from this origin. The forge's own
 * call carries no `Origin`; a cross-site form or fetch does, and is refused.
 */
function sameOrigin(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}

/** The page. The cursor and counts are an admin's to see, like the pull. */
function page(store: Store, last: PullResult | undefined, admin: boolean): string {
  const lastLine =
    last === undefined
      ? "No pull since this process started."
      : `Last pull: ${last.pulled} pulled, ${last.skipped} skipped, ${last.errors} errors.`;
  const detail = admin
    ? `<p>${store.count()} records held. Cursor: <code>${escape(store.cursor() || "(none yet)")}</code></p>
<p>${escape(lastLine)}</p>`
    : "<p>Pulls and their cursor are shown to the app's admins.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(SOURCE.name)} adapter</title></head><body><main>
<h1>${escape(SOURCE.name)} adapter</h1>
${detail}
</main></body></html>`;
}

export interface HandlerOptions {
  /** Reads the page after a cursor; the real source by default. */
  readonly read?: (cursor: string) => Promise<Page>;
  /** `FORGE_APP_IDENTITY_KEY`; empty means nobody is an admin. */
  readonly key: string;
  /** The clock signed identities are checked against. */
  readonly now?: () => number;
}

/** The request handler, over a store and the options above. */
export function makeHandler(
  store: Store,
  { read = (cursor) => readPage(cursor), key, now = Date.now }: HandlerOptions,
): (req: Request) => Promise<Response> {
  let last: PullResult | undefined;
  // One pull at a time: a second request waits for the first, then starts
  // from the cursor the first left.
  let queue: Promise<unknown> = Promise.resolve();
  return async (req) => {
    const { pathname } = new URL(req.url);
    const caller = who(req, key, now());
    if (pathname === "/pull") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);
      if (caller.role === "anon") return json({ error: "sign in as an admin of this app" }, 401);
      if (caller.role !== "admin") return json({ error: "only an admin of this app may pull" }, 403);
      const run = queue.then(() => pull(store, read));
      queue = run.catch(() => undefined);
      try {
        last = await run;
        return json(last);
      } catch (error) {
        // The cursor did not move; the forge records the failure. The detail
        // can name the source's host or URL, so it goes to the log, not the caller.
        console.error("pull failed:", error instanceof Error ? error.message : error);
        return json({ error: "pull failed" }, 502);
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return json({ error: "method not allowed" }, 405);
    if (pathname === "/healthz") return new Response("ok", { headers: HEADERS });
    if (pathname === "/")
      return new Response(page(store, last, caller.role === "admin"), {
        headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" },
      });
    return new Response("not found", { status: 404, headers: HEADERS });
  };
}

if (import.meta.main) {
  const data = process.env.FORGE_APP_DATA;
  if (data === undefined || data === "") throw new Error("FORGE_APP_DATA is not set");
  Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    hostname: process.env.HOST ?? "127.0.0.1",
    fetch: makeHandler(openStore(data), { key: process.env.FORGE_APP_IDENTITY_KEY ?? "" }),
  });
}
