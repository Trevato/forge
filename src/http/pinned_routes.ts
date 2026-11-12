/**
 * `/deploy-to` (#8744): the web door to a pinned forge. GET shows the form,
 * filled from `app`, `source` and `version` in the link; signed out, it sends
 * the visitor through one sign-in and back to the same link. POST is the same
 * `deployPinned` the API, MCP and terminal call, admin only and same-origin.
 */

import { checkPinned, deployPinned, pinnedForges, rollbackPinned, updatePinned } from "../actions/pinned.ts";
import { listCloudAccounts } from "../core/cloud_account.ts";
import { lastCheckOf } from "../core/pinned.ts";
import { getUsersByIds } from "../core/users.ts";
import { notFoundPage, signInFirst } from "../web/chrome.ts";
import { field, readForm } from "../web/form.ts";
import { flashTo, page } from "../web/layout.ts";
import { pinnedListPage } from "../web/pages/pinned.ts";
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

function listPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const forges = pinnedForges(ctx.app, ctx.auth.user);
  if (!forges.ok) return notFoundPage(ctx);
  const users = getUsersByIds(ctx.app.db, forges.value.flatMap((p) => p.changes.slice(0, 1).map((c) => c.by)));
  const names = new Map([...users].map(([id, u]) => [id, u.username]));
  const checks = new Map<string, string>();
  for (const p of forges.value) {
    const at = lastCheckOf(ctx.app.db, p.name);
    if (at) checks.set(p.name, at);
  }
  return page({ ctx, title: "Pinned forges", body: pinnedListPage(forges.value, { names, checks }) });
}

/** Update, Roll back and Check: the same actions the terminal's `u`, `r` and `c` call; admin only, same-origin, each refusal shown as its sentence. */
async function pinnedAct(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const name = ctx.params.name ?? "";
  const act = ctx.params.act ?? "";
  const user = ctx.auth.user;
  let done;
  if (act === "update") done = await updatePinned(ctx.app, user, name, { version: field(form, "version").trim().slice(0, 40) });
  else if (act === "rollback") done = await rollbackPinned(ctx.app, user, name);
  else if (act === "check") done = await checkPinned(ctx.app, user, name);
  else return notFoundPage(ctx);
  if (!done.ok) return flashTo(ctx, "/pinned", { tone: "danger", message: done.error });
  const at = done.value.version.slice(0, 12);
  const message =
    act === "check"
      ? `${name} ${"healthy" in done.value && done.value.healthy ? "answers" : "did not answer"}; it is ${done.value.state}.`
      : act === "update"
        ? `Updated ${name} to ${at}.`
        : `Rolled ${name} back to ${at}.`;
  return flashTo(ctx, "/pinned", { tone: "success", message });
}

export function pinnedRoutes(router: Router<Handler>): void {
  router.add("GET", "/pinned", listPage);
  router.add("POST", "/pinned/:name/:act", pinnedAct);
  router.add("GET", "/deploy-to", deployToPage);
  router.add("POST", "/deploy-to", deployToSubmit);
}
