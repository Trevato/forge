/**
 * GET/PUT /api/v1/forge/economics: the profit slider's position, the margin
 * on crew spend, the policy the position means (`core/slider.ts`), the
 * operator's prices and this month's cost so far (`core/cost.ts`), for a
 * forge admin who is a person — the twin of Settings → Economics, with the
 * same validation (`actions/economics.ts`). Anyone else is told 404.
 */

import { ECONOMICS_WORDS, changeEconomics, readEconomics, type EconomicsView } from "../../actions/economics.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Handler } from "../context.ts";
import { apiError, body, json, notFound } from "../respond.ts";
import type { Router } from "../router.ts";
import { accountAdmin } from "./admin.ts";

/** The wire shape: milliseconds and shares as numbers, `null` for never. */
export function wire(e: EconomicsView) {
  return {
    position: e.position,
    marginPct: e.marginPct,
    policy: e.policy,
    words: e.words,
    placement: e.placement,
    changes: e.changes,
    // Dollars with two decimals; slots a count (docs/PROFIT.md).
    prices: {
      ownedMonthUsd: e.prices.ownedMonthCents / 100,
      ownedSlots: e.prices.ownedSlots,
      cloudHourUsd: e.prices.cloudHourCents / 100,
      storageGbMonthUsd: e.prices.storageGbMonthCents / 100,
    },
    month: e.month,
  };
}

export function economicsRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/forge/economics", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = accountAdmin(ctx, "ro");
    if (denied) return denied;
    const read = readEconomics(ctx.app, ctx.auth.user);
    return read.ok ? json(wire(read.value), 200, { "cache-control": "private, no-cache" }) : notFound();
  });

  router.add("PUT", "/api/v1/forge/economics", async (ctx) => {
    const denied = accountAdmin(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    const changed = changeEconomics(ctx.app, ctx.auth.user, {
      position: input.position,
      marginPct: input.marginPct,
      ownedNodeLabel: input.ownedNodeLabel,
      ownedMonthUsd: input.ownedMonthUsd,
      ownedSlots: input.ownedSlots,
      cloudHourUsd: input.cloudHourUsd,
      storageGbMonthUsd: input.storageGbMonthUsd,
    });
    if (changed.ok) return json(wire(changed.value));
    if (changed.error === "not_found") return notFound();
    return apiError(changed.error, 422, ECONOMICS_WORDS[changed.error]);
  });
}
