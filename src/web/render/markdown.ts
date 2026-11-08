/** A Markdown file as prose, framed exactly the way a README is. */

import { html } from "../html.ts";
import { renderMarkdown } from "../markdown.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export function markdown(input: RenderInput): Rendered {
  const text = new TextDecoder().decode(input.body);
  return {
    lines: text === "" ? 0 : text.replace(/\n$/, "").split("\n").length,
    content: html`<div class="card prose">${renderMarkdown(text)}</div>`,
  };
}
