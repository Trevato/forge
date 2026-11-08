/**
 * Reading a submitted form, safely. Every form route is a browser mutation,
 * so it must be same-origin (CSRF), and a malformed body is an attack, not a
 * 500 — both are answered before any handler logic runs. When `minScope` is
 * given, the credential must also carry that scope: a session acts with full
 * authority, but a token is held to its stored scope, so a read-only token
 * cannot drive a write route — the same floor the git-push and JSON-API paths
 * enforce. Auth routes (sign in / up) pass no scope.
 */

import { CAME_FROM_ELSEWHERE, forbiddenPage, SENT_FROM_ELSEWHERE } from "./chrome.ts";
import { BODY_MAX, readBounded, STRANGER_MAX } from "../http/limits.ts";
import { scopeAllows, type TokenScope } from "../core/tokens.ts";
import { isLocalPath } from "./flash.ts";
import { crossOrigin, type Ctx } from "../http/context.ts";

export type Form = Awaited<ReturnType<Request["formData"]>>;

export async function readForm(
  ctx: Ctx,
  minScope?: TokenScope,
  /**
   * The most bytes this form may be: by default BODY_MAX for a signed-in
   * caller and STRANGER_MAX for anyone else (\`http/limits.ts\`).
   */
  max: number = ctx.auth.user === undefined ? STRANGER_MAX : BODY_MAX,
): Promise<Form | Response> {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log))
    return forbiddenPage(ctx, SENT_FROM_ELSEWHERE, CAME_FROM_ELSEWHERE);
  if (minScope !== undefined) {
    if (
      ctx.auth.scope === undefined ||
      !scopeAllows(ctx.auth.scope, minScope)
    ) {
      return forbiddenPage(ctx, "This token is not allowed to do this.");
    }
  }
  // Counted as it arrives (\`http/limits.ts\`), then parsed as what it says
  // it is — urlencoded or multipart — from the bytes kept.
  const bytes = await readBounded(ctx.request, max);
  if (bytes === "too_large")
    return new Response("payload too large", { status: 413 });
  const type = ctx.request.headers.get("content-type");
  // A form with no fields — a bare button, or a client that sent no body
  // at all — is an empty form, not a malformed one.
  if (type === null || bytes.byteLength === 0)
    return new FormData() as unknown as Form;
  try {
    return await new Response(bytes, {
      headers: { "content-type": type },
    }).formData();
  } catch {
    return new Response("bad request", { status: 400 });
  }
}

/** A form field as a trimmed string, or "" when absent or a file. */
export function field(form: Form, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Where a form asks to land back: its `back` field when that is a path on
 * this origin, otherwise `fallback`. Never a URL — a caller writes this
 * field, so anything with a scheme or host is dropped.
 */
export function backTo(form: Form, fallback: string): string {
  const back = field(form, "back");
  return isLocalPath(back) ? back : fallback;
}

/** Whether the client asked for JSON — a script keeping the page in place —
 * rather than the redirect a plain form gets. */
export function prefersJson(ctx: Ctx): boolean {
  return (ctx.request.headers.get("accept") ?? "").includes("application/json");
}
