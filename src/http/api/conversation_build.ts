/**
 * Talk builds an app over the API (#11010): `POST /api/v1/builds` makes the
 * repository from a template and starts the chat in it; a build's state,
 * each version's diff, Restore and Publish hang under
 * `/api/v1/conversations/:id/build`. Same-origin and rw only, as every
 * conversation change is; every answer is for the person's own conversation.
 */

import { BUILD_WORDS, buildState, publishBuild, restoreVersion, startBuild, versionDiff, type BuildError } from "../../actions/build.ts";
import { TALK_WORDS } from "../../actions/talk.ts";
import { WORDS_MAX } from "../../core/fence.ts";
import { apiError, boundedBody, json, tryAgain, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";
import type { Handler } from "../context.ts";
import { mayChange } from "./conversation_talk.ts";

const ID = /^[0-9a-z]{1,40}$/;
const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const STATUS: Readonly<Record<BuildError, number>> = { unauthorized: 401, not_found: 404, no_name: 422, no_version: 404, nothing_to_publish: 409, moved: 409, bad_template: 422, rate_limited: 422, too_many_builds: 422, failed: 422 };

/** Both build limits are per hour: say so with the 429 (#10762). */
const BUILD_WAIT = 3600;
const fail = (error: BuildError) =>
  error === "rate_limited" || error === "too_many_builds"
    ? tryAgain(error, 429, BUILD_WORDS[error] ?? error, BUILD_WAIT)
    : apiError(error, STATUS[error], BUILD_WORDS[error] ?? error);

export function conversationBuildRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/builds", async (ctx) => {
    const user = mayChange(ctx);
    if (user instanceof Response) return user;
    const input = await boundedBody(ctx.request, 20_000);
    if (input === "too_large") return apiError("too_large", 413, "at most 20000 bytes");
    const prompt = input["prompt"];
    if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > WORDS_MAX) return apiError("invalid_prompt", 422, `prompt is a string of 1 to ${WORDS_MAX} characters`);
    const template = input["template"];
    if (template !== undefined && (typeof template !== "string" || !TEMPLATE.test(template))) return apiError("invalid_template", 422, "template is owner/name");
    const started = await startBuild(ctx.app, user, { prompt, ...(template === undefined ? {} : { template }) });
    if (!started.ok) return fail(started.error);
    const { build, repo, said } = started.value;
    return json({ conversation: build.conversationId, repo: `${repo.ownerName}/${repo.name}`, branch: build.branch, ...(said === undefined ? {} : { said, message: TALK_WORDS[said][1] }) }, 201);
  });

  const named = (id: string | undefined): string | undefined => (id !== undefined && ID.test(id) ? id : undefined);

  router.add("GET", "/api/v1/conversations/:id/build", async (ctx) => {
    if (ctx.auth.user === undefined) return unauthorized();
    const id = named(ctx.params["id"]);
    if (id === undefined) return fail("not_found");
    const state = await buildState(ctx.app, ctx.auth.user, id);
    return state.ok ? json({ repo: state.value.repoName, branch: state.value.build.branch, versions: state.value.versions, previewUrl: state.value.previewUrl, previewState: state.value.previewState, published: state.value.published, productionUrl: state.value.productionUrl }) : fail(state.error);
  });

  router.add("GET", "/api/v1/conversations/:id/build/versions/:n/diff", async (ctx) => {
    if (ctx.auth.user === undefined) return unauthorized();
    const id = named(ctx.params["id"]);
    const n = Number(ctx.params["n"]);
    if (id === undefined || !Number.isInteger(n) || n < 1) return fail("no_version");
    const diff = await versionDiff(ctx.app, ctx.auth.user, id, n);
    return diff.ok ? json(diff.value) : fail(diff.error);
  });

  router.add("POST", "/api/v1/conversations/:id/build/restore", async (ctx) => {
    const user = mayChange(ctx);
    if (user instanceof Response) return user;
    const id = named(ctx.params["id"]);
    const input = await boundedBody(ctx.request, 1_000);
    if (input === "too_large") return apiError("too_large", 413, "at most 1000 bytes");
    const n = input["version"];
    if (id === undefined) return fail("not_found");
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return apiError("invalid_version", 422, "version is the number of a version, from 1");
    const restored = await restoreVersion(ctx.app, user, id, n);
    return restored.ok ? json({ version: restored.value }, 201) : fail(restored.error);
  });

  router.add("POST", "/api/v1/conversations/:id/build/publish", async (ctx) => {
    const user = mayChange(ctx);
    if (user instanceof Response) return user;
    const id = named(ctx.params["id"]);
    if (id === undefined) return fail("not_found");
    const published = await publishBuild(ctx.app, user, id);
    return published.ok ? json({ published: true, productionUrl: published.value.productionUrl }) : fail(published.error);
  });
}
