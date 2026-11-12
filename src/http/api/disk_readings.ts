/**
 * Disk readings over the API (#10465): `PUT /api/v1/admin/machines/:machine/disks/:device`
 * files smartctl's JSON (body `{smartctl, cpu?, memoryBytes?}`, `smartctl` the
 * text or the object); `GET /api/v1/admin/machines/:machine/disks` reads the
 * summary. The owner's admin-scope credential writes, any scope of it reads.
 */
import { fileReading, readMachine } from "../../actions/disk_readings.ts";
import { crossOrigin, type Handler } from "../context.ts";
import { apiError, boundedBody, forbidden, json, notFound, requireScope, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

/** smartctl's text is capped at 4 MB by the parser; room for the JSON wrapping it. */
const BODY_MAX = 4_300_000;

export function diskReadingRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/admin/machines/:machine/disks", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return notFound();
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const r = readMachine(ctx.app, ctx.auth.user, ctx.params.machine ?? "");
    return r.ok ? json(r.value) : notFound();
  });
  router.add("PUT", "/api/v1/admin/machines/:machine/disks/:device", async (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    if (!ctx.auth.user.isAdmin) return notFound();
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    if (ctx.auth.via === "session" && crossOrigin(ctx.request, ctx.url, ctx.app.log)) return forbidden();
    const input = await boundedBody(ctx.request, BODY_MAX);
    if (input === "too_large") return apiError("too_large", 413, "The request is too large.");
    const smart = input["smartctl"];
    const text = typeof smart === "string" ? smart : smart !== null && typeof smart === "object" ? JSON.stringify(smart) : "";
    const inventory =
      input["cpu"] === undefined && input["memoryBytes"] === undefined
        ? undefined
        : { cpu: input["cpu"] as string, memoryBytes: input["memoryBytes"] as number };
    const r = fileReading(ctx.app, ctx.auth.user, ctx.params.machine ?? "", ctx.params.device ?? "", text, inventory);
    if (r.ok) return json(r.value, 201);
    return r.error.code === "invalid" ? apiError("invalid", 422, r.error.says) : notFound();
  });
}
