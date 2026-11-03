/**
 * A pin's screenshots over the API: a tree kept by `refs/shots/<label>`
 * (`git/shots.ts`), changed through `actions/build_shots.ts` by a person
 * who writes the repository. Reading is the repository's readers'; every
 * write needs the `rw` scope.
 */

import { editShot, pickableLooks, pickShots, removeShot, uploadShot, type ShotsError } from "../../actions/build_shots.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { lookUrl } from "../../core/looks.ts";
import type { Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { readBuildPin } from "../../git/builds.ts";
import { repoDir } from "../../git/repos.ts";
import { readShots, type Shots } from "../../git/shots.ts";
import { mayFetchLook } from "../../web/pages/looks.ts";
import { loadRepo } from "../api.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { readBounded } from "../limits.ts";
import { apiError, body, json, notFound, requireScope, respondAccess } from "../respond.ts";
import type { Router } from "../router.ts";

const UPLOAD_MAX = 3 * 1024 * 1024;
const STATUS: Record<string, number> = { too_large: 413, moved: 409, too_many: 409, mirrored: 409, no_such_shot: 404 };

const items = (repo: Repo, label: string, shots: Shots) => ({
  items: shots.items.map((s) => ({
    file: s.file,
    caption: s.caption,
    type: s.type,
    size: s.size,
    url: `/${repo.ownerName}/${repo.name}/builds/${encodeURIComponent(label)}/shots/${s.file}?v=${s.oid.slice(0, 12)}`,
  })),
  next_cursor: null,
  tree: shots.tree ?? null,
});

const answer = (repo: Repo, label: string, done: { ok: true; value: Shots } | { ok: false; error: ShotsError }, status = 200) =>
  done.ok ? json(items(repo, label, done.value), status) : respondAccess(done.error, STATUS[done.error] ?? 422);

export function buildShotRoutes(router: Router<Handler>): void {
  const dirOf = (repo: Repo, root: string) => repoDir(root, repo.ownerName, repo.name);

  router.add("GET", "/api/v1/repos/:owner/:name/builds/:label/shots", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const label = ctx.params.label ?? "";
    const dir = dirOf(repo, ctx.app.reposRoot);
    if ((await readBuildPin(dir, label)) === undefined) return notFound();
    // The tag is of the exact bytes sent, so an upload, delete, pick, caption or reorder moves it;
    // private because a private repository's pictures are for its readers only.
    const text = JSON.stringify(items(repo, label, await readShots(dir, label)));
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });

  // Upload one: multipart, the picture as `shot`, an optional `caption` and the `tree` it was read from as `at`.
  router.add("POST", "/api/v1/repos/:owner/:name/builds/:label/shots", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const bytes = await readBounded(ctx.request, UPLOAD_MAX);
    if (bytes === "too_large") return apiError("too_large", 413, "a screenshot is at most 2 MB");
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await new Response(bytes, { headers: { "content-type": ctx.request.headers.get("content-type") ?? "" } }).formData();
    } catch {
      return apiError("invalid_shot", 422, "send multipart/form-data with the picture as `shot`");
    }
    const file = form.get("shot");
    const picture = typeof file === "string" || file === null ? new Uint8Array() : new Uint8Array(await file.arrayBuffer());
    const caption = form.get("caption");
    const label = ctx.params.label ?? "";
    const at = form.get("at");
    const done = await uploadShot(ctx.app, ctx.auth.user, repo, label, picture, typeof caption === "string" ? caption : "", typeof at === "string" ? at : undefined);
    return answer(repo, label, done, 201);
  });

  // What a deploy of the pin's commit was pictured as: what may be picked.
  router.add("GET", "/api/v1/repos/:owner/:name/builds/:label/shots/looks", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const pin = await readBuildPin(dirOf(repo, ctx.app.reposRoot), ctx.params.label ?? "");
    if (pin === undefined) return notFound();
    const record = getAppByRepo(ctx.app.db, repo.id);
    const base = `/${repo.ownerName}/${repo.name}`;
    const looks = record === undefined ? [] : pickableLooks(ctx.app, repo, pin).filter((l) => mayFetchLook(ctx, repo, record, l));
    // The tag is of the bytes sent, after the viewer's filter: a new look changes it,
    // and a viewer who may fetch fewer has another. Private: the filter is per viewer.
    const text = JSON.stringify({
      items: looks.map((l) => ({ id: l.id, page: l.page, kind: l.kind, theme: l.theme, env: l.env, url: lookUrl(base, l) })),
      next_cursor: null,
    });
    const etag = weakEtag(text);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return new Response(text, { headers: { "content-type": "application/json", ...headers } });
  });

  // Pick: `{ looks: [id, …], at }`, copied in, in that order.
  router.add("POST", "/api/v1/repos/:owner/:name/builds/:label/shots/looks", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const ids = Array.isArray(input.looks) ? input.looks.filter((v): v is string => typeof v === "string") : [];
    const label = ctx.params.label ?? "";
    return answer(repo, label, await pickShots(ctx.app, ctx.auth.user, repo, label, ids, typeof input.at === "string" ? input.at : undefined), 201);
  });

  // Edit one: `{ caption }` and/or `{ move: "up" | "down" }`, with the `tree` it was read from as `at`.
  router.add("POST", "/api/v1/repos/:owner/:name/builds/:label/shots/:file", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    const move = input.move === "up" || input.move === "down" ? input.move : undefined;
    if (input.move !== undefined && move === undefined) return apiError("invalid_move", 422, "move is up or down");
    const label = ctx.params.label ?? "";
    const done = await editShot(ctx.app, ctx.auth.user, repo, label, ctx.params.file ?? "", {
      ...(typeof input.caption === "string" ? { caption: input.caption } : {}),
      ...(move === undefined ? {} : { move }),
      ...(typeof input.at === "string" ? { at: input.at } : {}),
    });
    return answer(repo, label, done);
  });

  router.add("DELETE", "/api/v1/repos/:owner/:name/builds/:label/shots/:file", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const label = ctx.params.label ?? "";
    const at = ctx.url.searchParams.get("at") ?? undefined;
    const done = await removeShot(ctx.app, ctx.auth.user, repo, label, ctx.params.file ?? "", at);
    return done.ok ? new Response(null, { status: 204 }) : respondAccess(done.error, STATUS[done.error] ?? 422);
  });
}
