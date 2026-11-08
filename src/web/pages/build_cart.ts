/**
 * A pin's cart, played: its captured page and its picture
 * (`arcade/carts.ts`), to whoever reads the repository. The page is a
 * build's own HTML, so it is served sandboxed — an opaque origin that may
 * run its scripts and reach nothing of the forge's: no cookie, no storage,
 * no request back with the viewer's session.
 */

import { cartOf } from "../../actions/build_cart.ts";
import { readArt, readCapture } from "../../arcade/carts.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage } from "../chrome.ts";

/** What a played cart may do: run its own scripts, styles and pictures inline, nothing else, nowhere else. */
export const CART_POLICY =
  "sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; form-action 'none'; frame-ancestors 'self'";

async function cartBytes(ctx: Ctx, art: boolean): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const cart = await cartOf(ctx.app, ctx.auth.user, repo, ctx.params.label ?? "");
  if (!cart.ok || cart.value.demo === undefined) return notFoundPage(ctx);
  const { oid, demo } = cart.value;
  const bytes = (art ? readArt : readCapture)(ctx.app.config.dataDir, repo, oid, demo.page);
  if (bytes === undefined) return notFoundPage(ctx);
  // A capture is written once per commit and page: the bytes never change.
  const etag = `"${oid.slice(0, 16)}${art ? "-art" : ""}"`;
  const headers = {
    "content-type": art ? "image/png" : "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-security-policy": art ? "default-src 'none'; sandbox" : CART_POLICY,
    "referrer-policy": "no-referrer",
    etag,
    "cache-control": "private, no-cache",
  };
  if (ctx.request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(bytes, { headers });
}

// GET /:owner/:name/builds/:label/cart — the captured page, played sandboxed.
export const cartPage = (ctx: Ctx): Promise<Response> => cartBytes(ctx, false);
// GET /:owner/:name/builds/:label/cart.png — its picture, the cover's art.
export const cartArt = (ctx: Ctx): Promise<Response> => cartBytes(ctx, true);
