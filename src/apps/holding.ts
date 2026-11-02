/**
 * An app host is never the forge's. The listener opens before the apps
 * runtime is registered, and in that window a request for
 * `hello.<domain>` has no runtime to resolve against and would fall through
 * to the forge's own router (#6726). While a forge holds its app hosts, a
 * request for one waits briefly for the load, then gets a small page with
 * `Retry-After`: never a forge page.
 */

import type { App } from "../app.ts";
import { appsRuntime } from "./runtime.ts";
import { parseAppHost } from "./proxy.ts";

/** How long a request waits for the apps to load before the holding page. */
export const HOLD_WAIT_MS = 2000;

interface Hold {
  domain: string;
  release: () => void;
  released: Promise<void>;
}

const holds = new WeakMap<App, Hold>();

/**
 * The domain this forge's app hosts live under, kept from boot so a request
 * can be told apart before any runtime is registered.
 */
export function holdAppHosts(app: App, domain: string): void {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  holds.set(app, { domain, release, released });
}

/** The runtime is registered: waiting requests go on to the proxy. */
export function releaseAppHosts(app: App): void {
  holds.get(app)?.release();
}

const PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Coming back</title><body><p>This app is coming back. Try again in a moment.</p>";

/**
 * `undefined` when the request is not for an app host of this forge, or a
 * runtime is registered; the holding page otherwise. A request for an app
 * host never reaches the forge's router: with no runtime it waits (at most
 * `waitMs`) for one to be registered, then gets a 503.
 */
export async function holdAppHost(
  app: App,
  request: Request,
  waitMs = HOLD_WAIT_MS,
): Promise<Response | undefined> {
  if (appsRuntime(app) !== undefined) return undefined;
  const hold = holds.get(app);
  if (hold === undefined) return undefined;
  const host = request.headers.get("host");
  if (host === null || parseAppHost(host, hold.domain) === undefined)
    return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  await Promise.race([hold.released, timeout]);
  clearTimeout(timer);
  if (appsRuntime(app) !== undefined) return undefined;
  return new Response(request.method === "HEAD" ? null : PAGE, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": "2",
      "cache-control": "no-store",
    },
  });
}
