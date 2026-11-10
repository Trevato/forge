/**
 * `POST /api/v1/devices/:id/print` — an app prints a PDF on a device its
 * owner granted it. The credential is the app's own token; the body is the
 * PDF. The route takes a device number and nothing that names an address.
 */

import { PRINT_WORDS, PDF_MAX_BYTES, permitPrint, printFor, releasePermit, type PrintError } from "../../devices/print.ts";
import type { Handler } from "../context.ts";
import { readBounded } from "../limits.ts";
import { apiError, json, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";
import { tokenSecret } from "../token_header.ts";

const STATUS: Record<PrintError, number> = {
  forbidden: 403,
  rate_limited: 429,
  daily_cap: 429,
  not_pdf: 422,
  too_large: 422,
  too_many_pages: 422,
  pages_unknown: 422,
  printer_unreachable: 502,
  printer_refused: 502,
};

export function printRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/devices/:id/print", async (ctx) => {
    const secret = tokenSecret(ctx.request.headers.get("authorization") ?? "");
    if (secret === null) return unauthorized();
    const id = /^\d{1,9}$/.test(ctx.params["id"] ?? "") ? Number(ctx.params["id"]) : Number.NaN;
    // Who and where first; the body (up to 10 MB) is read only for a granted app.
    const permit = permitPrint(ctx.app, secret, id);
    if (!permit.ok) return apiError(permit.error, STATUS[permit.error], PRINT_WORDS[permit.error]);
    // The permit holds a place until printFor, or here when the body never gets that far.
    let pdf: Awaited<ReturnType<typeof readBounded>>;
    try {
      pdf = await readBounded(ctx.request, PDF_MAX_BYTES);
    } catch (e) {
      releasePermit(permit.value);
      throw e;
    }
    if (pdf === "too_large") {
      releasePermit(permit.value);
      return apiError("too_large", 422, PRINT_WORDS.too_large);
    }
    const done = await printFor(ctx.app, permit.value, pdf);
    if (!done.ok) return apiError(done.error, STATUS[done.error], PRINT_WORDS[done.error]);
    return json({ job: { id: done.value.id, state: done.value.state, reasons: done.value.reasons } });
  });
}
