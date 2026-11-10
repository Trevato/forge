/**
 * POST /feed/like: the Like button without a script. The same act as the
 * feed API's `liked` (`feed/likes.ts`), refused the same ways, then back to
 * the feed; with a script asking for JSON it answers the new count instead.
 */

import { readInteraction } from "../../feed/interact.ts";
import { setLike } from "../../feed/likes.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { backTo, field, readForm } from "../form.ts";
import { flashOrJson } from "../layout.ts";

export async function likeSubmit(ctx: Ctx): Promise<Response> {
  const viewer = ctx.auth.user;
  if (!viewer) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const act = readInteraction(
    ctx.app.db,
    viewer,
    { item: field(form, "item"), kind: "liked", app: field(form, "app") },
    ["liked"],
  );
  if (!act.ok) return notFoundPage(ctx);
  // `act` names the wish ("like" unless it says "unlike"), so a repeat press is a no-op.
  const wish = field(form, "act") === "unlike" ? "unlike" : "like";
  const now = setLike(ctx.app.db, viewer.id, act.value.itemId, act.value.target.repoId, wish);
  return flashOrJson(ctx, backTo(form, "/feed"), { message: now.liked ? "Liked." : "Like taken back." }, { ...now });
}
