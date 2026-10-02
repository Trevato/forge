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
 * - Signing out sends `clear`, which empties the cache: the last feed is
 *   one person's and must not outlive their session.
 */

import { sha256 } from "../kernel/hash.ts";

export const SW_CACHE = "forge-shell-v1";

const source = /* js */ `
var CACHE = ${JSON.stringify(SW_CACHE)};
self.addEventListener('install', function () { self.skipWaiting(); });
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
  if (url.pathname === '/' && request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (r) {
      return keep(new Request('/'), r);
    }, function () {
      return caches.match('/').then(function (hit) {
        return hit ? stale(hit) : Response.error();
      });
    }));
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

export function serviceWorker(): Response {
  return new Response(source, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      etag: ETAG,
      "service-worker-allowed": "/",
    },
  });
}
