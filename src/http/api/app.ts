/**
 * A repository's app over the API: `…/app` itself (read, enable, change,
 * disable), the people a private app names, its own domains, its
 * environment variables, pulling an adapter now, and redeploying, stopping and opening one
 * environment. The rules live in `actions/apps.ts`, `actions/app_members.ts`
 * and `actions/domains.ts`.
 */

import { readAppMembers, setAppMembersThrough, type AppMembersError } from "../../actions/app_members.ts";
import { appView, appVisitors, deleteAppEnvVar, disableApp, enableApp, listAppEnv, openEnvUrl, redeployEnv, setAppEnvVar, stopEnv, updateAppSettings, type AppSettingsInput } from "../../actions/apps.ts";
import { pullNow, PULL_NOW_REFUSALS } from "../../actions/app_pull.ts";
import { addAppDomain, checkAppDomain, keepOldRecords, listAppDomains, removeAppDomain } from "../../actions/domains.ts";
import { previewBuild, previewBuildRefusalText } from "../../actions/build_preview.ts";
import { SETTING_WORDS } from "../../actions/setting_words.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Result } from "../../kernel/result.ts";
import { appJson, appLimitResponse, loadRepo } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { BUILD_ASKS_WINDOW_MS } from "../../actions/build_preview.ts";
import { apiError, body, json, notFound, requireScope, respondAccess, str, tryAgain, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";

function appPatch(input: Record<string, unknown>): AppSettingsInput {
  return {
    ...(typeof input.slug === "string" ? { slug: input.slug } : {}),
    ...(input.access === "public" || input.access === "private"
      ? { access: input.access }
      : {}),
    ...(input.previewData === "copy" || input.previewData === "empty"
      ? { previewData: input.previewData }
      : {}),
  };
}

/** An app-members answer: the list, or the refusal a stranger cannot read anything into. */
function membersAnswer<T>(result: Result<T, AppMembersError>): Response {
  if (result.ok) return json(result.value);
  switch (result.error.kind) {
    case "invalid":
      return apiError("invalid", 422, result.error.message);
    case "forbidden":
      return apiError("forbidden", 403, SETTING_WORDS.appMembersForbidden);
    case "unauthorized":
      return unauthorized();
    default:
      return notFound();
  }
}

/**
 * An access-checked read tagged by its own bytes (#9178): `private, no-cache`
 * and varied on the credential, so a repeat holding the tag is a bodiless 304
 * until the data moves. Called only after the access check passed.
 */
function tagged(ctx: Ctx, data: unknown): Response {
  const text = JSON.stringify(data);
  const etag = weakEtag(text);
  const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
  if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { "content-type": "application/json", ...headers } });
}

export function appRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/app", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const read = timePhase(ctx.request, "app", () => {
      const view = appView(ctx.app, ctx.auth.user, repo);
      if (!view.ok) return null;
      return { view: view.value, vitals: appVisitors(ctx.app, ctx.auth.user, repo) };
    });
    if (!read) return notFound();
    return timePhase(ctx.request, "render", () =>
      tagged(ctx, {
        ...appJson(ctx, read.view.app, repo, appsRuntime(ctx.app)),
        ...(read.vitals === undefined ? {} : { vitals: read.vitals }),
      }),
    );
  });

  router.add("POST", "/api/v1/repos/:owner/:name/app", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const enabled = enableApp(ctx.app, ctx.auth.user, repo, appPatch(input));
    if (!enabled.ok) {
      if (enabled.error === "app_limit")
        return appLimitResponse(ctx, repo.ownerName);
      return respondAccess(enabled.error, 422);
    }
    return json(
      appJson(ctx, enabled.value, repo, appsRuntime(ctx.app)),
      201,
    );
  });

  router.add("PATCH", "/api/v1/repos/:owner/:name/app", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const updated = updateAppSettings(
      ctx.app,
      ctx.auth.user,
      repo,
      appPatch(input),
    );
    if (!updated.ok) return respondAccess(updated.error, 422);
    return json(appJson(ctx, updated.value, repo, appsRuntime(ctx.app)));
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/app", (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const disabled = disableApp(ctx.app, ctx.auth.user, repo);
    if (!disabled.ok) return respondAccess(disabled.error, 422);
    return json({}, 200);
  });

  // The people a private app names (#752): they may enter it and its
  // previews, nothing else. Read and changed by people who can write the
  // repository, never an agent; a change is planned unless dryRun is false.
  router.add("GET", "/api/v1/repos/:owner/:name/app/members", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const read = timePhase(ctx.request, "members", () => readAppMembers(ctx.app, ctx.auth.user, repo));
    return timePhase(ctx.request, "render", () => (read.ok ? tagged(ctx, read.value) : membersAnswer(read)));
  });

  router.add("PUT", "/api/v1/repos/:owner/:name/app/members", async (ctx) => {
    const input = await body(ctx.request);
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const members = input.members;
    if (!Array.isArray(members) || !members.every((m) => typeof m === "string"))
      return apiError("invalid", 422, "send {members: [username, …], dryRun}");
    return membersAnswer(
      setAppMembersThrough(ctx.app, ctx.auth.user, repo, {
        members,
        dryRun: input.dryRun !== false,
      }),
    );
  });

  // The app's own domains (docs/APPS.md, "Your own domain"). Admin scope
  // and admin over the repository, like the environment below; `:host` is
  // one path segment, dots included.
  router.add("GET", "/api/v1/repos/:owner/:name/app/domains", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const listed = timePhase(ctx.request, "domains", () => listAppDomains(ctx.app, ctx.auth.user, repo));
    if (!listed.ok) return respondAccess(listed.error, 422);
    return timePhase(ctx.request, "render", () => tagged(ctx, { items: listed.value, next_cursor: null }));
  });

  router.add("POST", "/api/v1/repos/:owner/:name/app/domains", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const added = addAppDomain(ctx.app, ctx.auth.user, repo, str(input.host), input.old_records);
    if (!added.ok) return respondAccess(added.error, 422);
    return json(added.value, 201);
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/app/domains/:host/check",
    async (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const checked = await checkAppDomain(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.host ?? "",
      );
      if (!checked.ok) return respondAccess(checked.error, 422);
      return json(checked.value);
    },
  );

  router.add("PUT", "/api/v1/repos/:owner/:name/app/domains/:host/old-records", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const kept = keepOldRecords(ctx.app, ctx.auth.user, repo, ctx.params.host ?? "", input.records);
    if (!kept.ok) return respondAccess(kept.error, 422);
    return json(kept.value);
  });

  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/app/domains/:host",
    (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const removed = removeAppDomain(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.host ?? "",
      );
      if (!removed.ok) return respondAccess(removed.error, 422);
      return json({}, 200);
    },
  );

  // The app's environment: names in, names out, and never a value back.
  // `:var`, not `:name` — `:name` is the repository's.
  router.add("GET", "/api/v1/repos/:owner/:name/app/env", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const listed = timePhase(ctx.request, "env", () => listAppEnv(ctx.app, ctx.auth.user, repo));
    if (!listed.ok) return notFound();
    return timePhase(ctx.request, "render", () => tagged(ctx, { items: listed.value, next_cursor: null }));
  });

  router.add("PUT", "/api/v1/repos/:owner/:name/app/env/:var", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    // `scope`: all (the default), production, or preview. The same name may
    // be set once in each; the narrower one wins where both apply.
    const set = await setAppEnvVar(
      ctx.app,
      ctx.auth.user,
      repo,
      ctx.params.var ?? "",
      str(input.value),
      str(input.scope) || "all",
    );
    if (!set.ok) return respondAccess(set.error, 422);
    return json(set.value);
  });

  router.add(
    "DELETE",
    "/api/v1/repos/:owner/:name/app/env/:var",
    async (ctx) => {
      const denied = requireScope(ctx, "admin");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const removed = await deleteAppEnvVar(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.var ?? "",
        ctx.url.searchParams.get("scope") ?? "all",
      );
      if (!removed.ok) return respondAccess(removed.error, 422);
      return json({}, 200);
    },
  );

  // Pull now (#10084): one adapter pull through the schedule's own path,
  // answered with the recorded run. A sleeping app is refused, never woken.
  router.add("POST", "/api/v1/repos/:owner/:name/app/pull", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const pulled = await pullNow(ctx.app, ctx.auth.user, repo);
    if (pulled.ok) return json({ run: pulled.value }, 200);
    const error = pulled.error;
    if (error === "no_adapter") return apiError(error, 404, PULL_NOW_REFUSALS[error]);
    if (error === "asleep" || error === "in_flight") return apiError(error, 409, PULL_NOW_REFUSALS[error]);
    return respondAccess(error, 422);
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/app/:env/redeploy",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const queued = await redeployEnv(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.env ?? "",
      );
      if (!queued.ok) return respondAccess(queued.error, 422);
      return json({ run: queued.value ?? null }, 202);
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/app/:env/stop",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const stopped = await stopEnv(
        ctx.app,
        ctx.auth.user,
        repo,
        ctx.params.env ?? "",
      );
      if (!stopped.ok) return respondAccess(stopped.error, 422);
      return json({}, 200);
    },
  );

  // Preview now: serve one commit `{ sha }` at its own short-lived
  // environment (`actions/build_preview.ts`). Nothing is stored; the answer
  // names the environment and where it is served.
  router.add("POST", "/api/v1/repos/:owner/:name/builds/preview", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const sha = typeof input["sha"] === "string" ? input["sha"] : "";
    const preview = await previewBuild(ctx.app, ctx.auth.user, repo, sha);
    if (!preview.ok)
      return preview.error === "rate_limited"
        ? tryAgain("rate_limited", 429, previewBuildRefusalText(preview.error), BUILD_ASKS_WINDOW_MS / 1000)
        : respondAccess(preview.error, 422);
    return json({ env: preview.value.env, url: preview.value.url }, 201);
  });

  // The URL to open an environment at. For a private app it carries a
  // grant, so the answer is for the caller alone and is not cached.
  router.add("GET", "/api/v1/repos/:owner/:name/app/:env/open", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
    if (!repo) return notFound();
    const link = timePhase(ctx.request, "open", () =>
      openEnvUrl(ctx.app, ctx.auth.user, repo, ctx.params.env ?? ""),
    );
    if (!link.ok) return respondAccess(link.error, 422);
    return json({ url: link.value });
  });
}
