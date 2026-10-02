/**
 * The service worker: the shell and the last feed, kept for when there is
 * no network. Nothing else is its business.
 *
 * - `/` is network-first. Every good answer is kept; when the network
 *   fails the kept one is served, marked `data-stale="1"` so the page says
 *   it is old (the region carries `data-rendered`, the time it was made).
 * - The stylesheet and content-addressed assets are cache-first (assets
 *   named by hash never change; the stylesheet is refreshed behind).
 * - Everything else — the API, `/events`, `/live/*`, every POST — goes
 *   straight to the network untouched. Writes made offline wait in the
 *   page's outbox (`outbox.ts`), not here.
 * - A navigation is never answered with `Response.error()`: no network and
 *   nothing kept gives an inline offline page (kept at install) that retries.
 * - The script's own CSP allows same-origin fetch (see SW_CSP); the floor's
 *   `default-src 'none'` made every fetch in the worker fail.
 * - FORGE_SW_KILL=1 serves a worker that unregisters itself.
 * - Signing out sends `clear`, which empties the cache: the last feed is
 *   one person's and must not outlive their session.
 */

import { sha256 } from "../kernel/hash.ts";

export const SW_CACHE = "forge-shell-v1";

/** Shown when the forge is unreachable and nothing is kept; it retries itself. */
export const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta http-equiv="refresh" content="5"><title>Forge is restarting</title></head>' +
  '<body style="font:16px system-ui;margin:3rem auto;max-width:30rem;padding:0 1rem">' +
  "<h1>The forge is restarting</h1><p>It will be back in a moment. This page retries every few seconds.</p>" +
  "</body></html>";

/** A worker that removes itself: served when FORGE_SW_KILL is set. */
export const killSource = `self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.registration.unregister(); }).then(function () {
    return self.clients.matchAll({ type: 'window' });
  }).then(function (all) { all.forEach(function (c) { c.navigate(c.url); }); }));
});
`;

const source = /* js */ `
var CACHE = ${JSON.stringify(SW_CACHE)};
var OFFLINE_URL = '/__offline';
var OFFLINE_HTML = ${JSON.stringify(OFFLINE_HTML)};
function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) {
    return c.put(OFFLINE_URL, offlineResponse());
  }).then(function () { return self.skipWaiting(); }));
});
function offline() {
  return caches.match(OFFLINE_URL).then(function (hit) { return hit || offlineResponse(); });
}
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('message', function (event) {
  if (event.data === 'clear') event.waitUntil(caches.delete(CACHE));
});
function keep(request, response) {
  if (response.ok && response.type === 'basic' && !response.redirected) {
    var copy = response.clone();
    caches.open(CACHE).then(function (c) { return c.put(request, copy); });
  }
  return response;
}
function stale(response) {
  return response.text().then(function (text) {
    return new Response(text.replace('data-stale="0"', 'data-stale="1"'), {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  });
}
self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.mode === 'navigate') {
    // never Response.error(): a restarting forge must not become a browser error page
    var home = url.pathname === '/';
    event.respondWith(fetch(request).then(function (r) {
      return home ? keep(new Request('/'), r) : r;
    }, function () {
      if (!home) return offline();
      return caches.match('/').then(function (hit) { return hit ? stale(hit) : offline(); });
    }).catch(offline));
    return;
  }
  if (url.pathname.indexOf('/assets/') === 0 || url.pathname.indexOf('/icons/') === 0) {
    event.respondWith(caches.match(request).then(function (hit) {
      var fresh = fetch(request).then(function (r) { return keep(request, r); }, function () { return hit || Response.error(); });
      return hit || fresh;
    }));
  }
});
`;

export const swSource = source;
const ETAG = `"${sha256(source).slice(0, 16)}"`;

/**
 * A worker takes its CSP from its own script response, and `connect-src`
 * falls back to `default-src`: with the floor's `'none'` every fetch() in the
 * worker is refused. The worker fetches same-origin only.
 */
export const SW_CSP = "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export function serviceWorker(): Response {
  const kill = !!process.env.FORGE_SW_KILL && process.env.FORGE_SW_KILL !== "0";
  return new Response(kill ? killSource : source, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      ...(kill ? {} : { etag: ETAG }),
      "service-worker-allowed": "/",
      "content-security-policy": SW_CSP,
    },
  });
}
