/**
 * Forge it: the verb beside Fork. One press on a repository spins up a fresh
 * forge with that repository as its app, and sends the person straight to the
 * new forge's claim link (the code rides the fragment, so nothing is copied).
 * It is `POST /forges/new` with the choices made for them: the name comes from
 * the repository, everything else is the spawn door's default.
 */

import type { Ctx } from "../../http/context.ts";
import { forgeIt } from "../../spawn/forge_it.ts";
import { loadRepo, notFoundPage, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { flashTo, redirect } from "../layout.ts";

// POST /:owner/:name/forge
export async function forgeItSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const back = `/${repo.ownerName}/${repo.name}`;
  const door = await forgeIt(ctx, user, repo);
  if (door.status >= 400)
    return flashTo(ctx, back, { tone: "danger", message: `Not forged: ${String(door.body["message"] ?? "it could not be made")}.` });
  const link = door.body["claimUrl"];
  if (typeof link !== "string")
    return flashTo(ctx, "/forges", { message: `${String(door.body["name"])} was forged before; its link is not shown again.` });
  const response = redirect(link);
  response.headers.set("cache-control", "no-store");
  return response;
}
