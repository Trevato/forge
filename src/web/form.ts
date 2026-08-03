/**
 * Reading a submitted form, safely. Every form route is a browser mutation,
 * so it must be same-origin (CSRF), and a malformed body is an attack, not a
 * 500 — both are answered before any handler logic runs.
 */

import { crossOrigin, type Ctx } from "../http/context.ts";

export type Form = Awaited<ReturnType<Request["formData"]>>;

export async function readForm(ctx: Ctx): Promise<Form | Response> {
  if (crossOrigin(ctx.request, ctx.url))
    return new Response("forbidden", { status: 403 });
  try {
    return await ctx.request.formData();
  } catch {
    return new Response("bad request", { status: 400 });
  }
}

/** A form field as a trimmed string, or "" when absent or a file. */
export function field(form: Form, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
