# The web, as the forge ships it

Short rules. `test/web-budget.test.ts` counts the bytes and fails when one is broken.

## What is an asset

Anything that is the same bytes for everyone and changes only when the code does: the stylesheet, the shell and beacon scripts, each page's own script, the icon sprite (`/assets/i-<hash>.svg`), the speculation rules. Each is named by a hash of its content (`web/asset.ts`) and sent `public, max-age=31536000, immutable`. Nothing inline: a page never carries a drawing or a script. Runtime data reaches a page script through `data-*` attributes. A page script is also kept under `<dataDir>/page-scripts/` the first time a process renders it, so after a restart an edge copy or a cached page that names it is still answered; the body read back must hash to its name, and a file nothing has rendered for 30 days is pruned.

## What is HTML

Markup only, and small. It names its assets; it never carries them. Budget: **home under 40 KB raw**, no inline `<script>` (a `type="application/json"` or `application/ld+json` data block is data), no inline `<symbol>`. The two inline `<style>` blocks (the boot theme and a page's own) are admitted by hash in the policy, not by a nonce, so a page is the same bytes for every visitor and can be cached.

## How each is cached

- Assets: immutable, a year.
- HTML, signed in or carrying any identity (cookie, `Authorization`, edge login headers) or a flash: `no-cache`, no ETag, never shared (`http/edge_cache.ts`, `http/respond.ts`).
- HTML, signed out, on a page that is the same for everyone (home, explore, the front page of a repository that exists and is public; any other path, two segments or not, is `no-cache`): `public, max-age=0, s-maxage=60, stale-while-revalidate=300` and a weak ETag; a revisit costs a 304. The shared copy carries `Vary: Cookie, Authorization, X-Plat-User, X-Plat-Edge-Token`, so an edge keys it on identity: a visitor with any of those misses it and reaches the origin, which answers `no-cache` and never the anonymous page. There is no purge call (the edge's credentials are not the forge's to hold), so staleness is bounded by those 60 + 300 seconds.

## The script policy

`script-src 'self'` admits any same-origin script URL, so no route that serves user-controlled bytes may answer with a script type. Raw files are `text/plain` (or `application/octet-stream`) under `nosniff` and `default-src 'none'; sandbox`; media never serves HTML or script; the only script-typed responses are the forge's own hashed files under `/assets/`, whose code is static (`test/web-budget.test.ts` checks the raw route and that an unknown `/assets/page-*.js` is a 404). Page scripts are kept by name for the life of the process, never evicted, because a cached page may name one for days.

## How a page streams

The response carries `Link: rel=preload` for the stylesheet and scripts, which an edge turns into 103 Early Hints, so the browser fetches them before the body arrives. The `<head>` comes first in the body, with the stylesheet link before any script. Scripts are `defer`.

## Next pages and the back button

The `Speculation-Rules` header points at one hashed rules file: prefetch, moderate eagerness (hover or pointer-down), never the API, assets, sign-in and sign-out, `/-/confirm`, claim, first-admin and verify links, `/go/`, settings, app-open, MCP, raw files, media or archives, never a URL whose query carries a token, code, key, secret or state, and never a link marked `nofollow`, `download` or `data-no-prefetch`. Back/forward cache stays on: no page sends `no-store`, and no script listens for `unload` or `beforeunload`.

## Not done

Streaming the body in chunks (the render is one string today); purge by event; the pages other than home, explore and a repository's front page measure the same budgets as a mechanical follow-up. Before/after numbers from #7559 are not producible from this sandbox.
