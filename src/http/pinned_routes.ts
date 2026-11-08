/**
 * `/deploy-to` (#8744): the web door to a pinned forge. GET shows the form,
 * filled from `app`, `source` and `version` in the link; signed out, it sends
 * the visitor through one sign-in and back to the same link. POST is the same
 * `deployPinned` the API, MCP and terminal call, admin only and same-origin.
 */

import { deployPinned } from "../actions/pinned.ts";
import { listCloudAccounts } from "../core/cloud_account.ts";
import { notFoundPage, signInFirst } from "../web/chrome.ts";
import { field, readForm } from "../web/form.ts";
import { flashTo, page } from "../web/layout.ts";
import { deployPage, nameFor, type DeployForm } from "../web/pinned.ts";
import type { Handler, Ctx } from "./context.ts";
import type { Router } from "./router.ts";

const seen = (get: (k: string) => string): DeployForm => {
  const app = get("app").trim().slice(0, 140);
  return {
    app,
    source: get("source").trim().slice(0, 400),
    version: get("version").trim().slice(0, 40),
    account: get("account").trim().slice(0, 40),
    name: get("name").trim().slice(0, 40) || nameFor(app),
  };
};

function render(ctx: Ctx, v: DeployForm, flash?: { tone: "danger"; message: string }): Response {
  return page(
    {
      ctx,
      title: "Deploy to…",
      body: deployPage(listCloudAccounts(ctx.app.db), v),
      ...(flash ? { flash } : {}),
    },
    flash ? 422 : 200,
  );
}

function deployToPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return render(ctx, seen((k) => ctx.url.searchParams.get(k) ?? ""));
}

async function deployToSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const v = seen((k) => field(form, k));
  const made = await deployPinned(ctx.app, ctx.auth.user, { ...v, target: "digitalocean" });
  if (!made.ok) return render(ctx, v, { tone: "danger", message: made.error });
  return flashTo(ctx, "/deploy-to", { message: `Deployed ${made.value.name} at ${made.value.version.slice(0, 12)}. It changes only when you press Update.` });
}

export function pinnedRoutes(router: Router<Handler>): void {
  router.add("GET", "/deploy-to", deployToPage);
  router.add("POST", "/deploy-to", deployToSubmit);
}
