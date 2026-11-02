/**
 * The picture a sender chose to send with a note from the forge button
 * (#4820): `GET /:owner/:name/issues/:number/picture`. It is read by exactly
 * those who can read the issue (`threadContext`, which also hides a sealed
 * report); everyone else gets the forge's not-found.
 */
import { PICTURE_TYPE, pictureOfIssue } from "../../core/note_pictures.ts";
import type { Ctx } from "../../http/context.ts";
import { threadContext } from "../pages/thread.ts";
import { notFoundPage } from "../chrome.ts";

export function issuePicture(ctx: Ctx): Response {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  const pic = pictureOfIssue(ctx.app.db, ctx.app.config.dataDir, found.repo.id, found.issue.number);
  if (pic === undefined) return notFoundPage(ctx);
  return new Response(pic.bytes, {
    headers: {
      "content-type": PICTURE_TYPE[pic.kind],
      "x-content-type-options": "nosniff",
      // A private repository's picture is not for a shared cache.
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
