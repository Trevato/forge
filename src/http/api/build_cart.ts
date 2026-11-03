/**
 * A pin's cart over the API (`actions/build_cart.ts`): what it is and how
 * its capture stands, to the repository's readers; naming it and starting
 * its capture needs the `rw` scope and a person who writes.
 */

import { cartOf, setCart, type Cart } from "../../actions/build_cart.ts";
import type { Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { body, json, notFound, requireScope, respondAccess } from "../respond.ts";
import type { Router } from "../router.ts";

const STATUS: Record<string, number> = { mirrored: 409, moved: 409, invalid_demo: 422, git_failed: 500 };

/** A cart as JSON: where it plays once captured. */
export const cartJson = (repo: Repo, cart: Cart) => {
  const at = `/${repo.ownerName}/${repo.name}/builds/${encodeURIComponent(cart.label)}/cart`;
  return {
    label: cart.label,
    oid: cart.oid,
    demo: cart.demo ?? null,
    capture: cart.capture,
    play_url: cart.capture.state === "done" ? at : null,
    art_url: cart.capture.state === "done" ? `${at}.png` : null,
  };
};

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

export function buildCartRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/builds/:label/cart", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const cart = await cartOf(ctx.app, ctx.auth.user, repo, ctx.params.label ?? "");
    return cart.ok ? json(cartJson(repo, cart.value)) : notFound();
  });

  // Name the cart ({ name, version, page, showcase }) and start capturing its page: 202 while it runs.
  router.add("POST", "/api/v1/repos/:owner/:name/builds/:label/cart", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const b = await body(ctx.request);
    const done = await setCart(ctx.app, ctx.auth.user, repo, ctx.params.label ?? "", {
      name: text(b.name, 200),
      version: text(b.version, 200),
      page: text(b.page, 400),
      showcase: b.showcase === true,
    });
    if (!done.ok) return respondAccess(done.error, STATUS[done.error] ?? 422);
    return json(cartJson(repo, done.value), done.value.capture.state === "done" ? 200 : 202);
  });
}
