/**
 * Reading a submitted form, safely. Every form route is a browser mutation,
 * so it must be same-origin (CSRF), and a malformed body is an attack, not a
 * 500 — both are answered before any handler logic runs. When `minScope` is
 * given, the credential must also carry that scope: a session acts with full
 * authority, but a token is held to its stored scope, so a read-only token
 * cannot drive a write route — the same floor the git-push and JSON-API paths
 * enforce. Auth routes (sign in / up) pass no scope.
 */

import { scopeAllows, type TokenScope } from "../core/tokens.ts";
import { crossOrigin, type Ctx } from "../http/context.ts";

export type Form = Awaited<ReturnType<Request["formData"]>>;

export async function readForm(
  ctx: Ctx,
  minScope?: TokenScope,
): Promise<Form | Response> {
  if (crossOrigin(ctx.request, ctx.url))
    return new Response("forbidden", { status: 403 });
  if (minScope !== undefined) {
    if (
      ctx.auth.scope === undefined ||
      !scopeAllows(ctx.auth.scope, minScope)
    ) {
      return new Response("forbidden", { status: 403 });
    }
  }
  try {
    return await ctx.request.formData();
  } catch {
    // A form with no fields — a bare button, or a client that sent no body
    // at all — is an empty form, not a malformed one.
    const type = ctx.request.headers.get("content-type");
    const length = ctx.request.headers.get("content-length");
    if (type === null || length === "0")
      return new FormData() as unknown as Form;
    return new Response("bad request", { status: 400 });
  }
}

/** A form field as a trimmed string, or "" when absent or a file. */
export function field(form: Form, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
