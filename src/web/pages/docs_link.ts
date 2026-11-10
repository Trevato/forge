/**
 * /docs and /docs/NAME.md: the forge's own documentation, read on the forge.
 * The folder is the release's checkout (`docs/` beside `src/`), never
 * FORGE_APP_DATA. A name is served only when it is in the listing of that
 * folder, so the request's text is looked up, never joined into a path.
 * Docs change only with the release, so the listing and each rendered doc
 * are kept in memory for the life of the process.
 */

import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { notFound } from "../../http/respond.ts";
import { docEntries, docEntry, docText } from "../../view/docs.ts";
import { html, raw, type Html } from "../html.ts";
import { renderMarkdown } from "../markdown.ts";
import { page } from "../layout.ts";
import { row } from "../ui.ts";

const rendered = new Map<string, Html>();

/** `OTHER.md` and `./OTHER.md` (with an anchor) become `/docs/OTHER.md` when OTHER.md is in the listing; any other link stays as written. */
export function relinkDocs(markup: string, known: ReadonlySet<string> = new Set(docEntries().map((e) => e.name))): string {
  return markup.replace(
    /href="(?:\.\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md)(#[^"]*)?"/g,
    (m, name: string, tail: string | undefined) => (known.has(name) ? `href="/docs/${name}${tail ?? ""}"` : m),
  );
}

export function docsFolder(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const began = performance.now();
  const list = docEntries();
  const res = page({
    ctx,
    title: "Documentation",
    description: "How the forge works, read on the forge.",
    crumbs: [{ href: "/docs", label: "Docs" }],
    body: html`<h1>Documentation</h1>
      <ul class="list">${list.map((e) => row({ href: `/docs/${e.name}`, title: e.title }))}</ul>`,
  });
  notePhase(ctx.request, "render", performance.now() - began);
  return res;
}

export function docsFile(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const began = performance.now();
  const name = ctx.params.file ?? "";
  const entry = docEntry(name);
  if (entry === undefined) return notFound();
  let body = rendered.get(name);
  if (body === undefined) {
    const text = docText(entry);
    // renderMarkdown escapes every character of the source; relinking only rewrites hrefs it made.
    body = raw(`<div class="prose">${relinkDocs(String(renderMarkdown(text)))}</div>`);
    rendered.set(name, body);
  }
  const res = page({
    ctx,
    title: entry.title,
    crumbs: [
      { href: "/docs", label: "Docs" },
      { href: `/docs/${name}`, label: name },
    ],
    body,
  });
  notePhase(ctx.request, "render", performance.now() - began);
  return res;
}
