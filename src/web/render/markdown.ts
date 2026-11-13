/** A Markdown file as prose, framed exactly the way a README is. */

import { html } from "../html.ts";
import { markdownTasks, renderMarkdown } from "../markdown.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export function markdown(input: RenderInput): Rendered {
  const slash = input.path.lastIndexOf("/");
  const repo =
    input.repo === undefined
      ? undefined
      : { ...input.repo, dir: slash < 0 ? "" : input.path.slice(0, slash) };
  const text = new TextDecoder().decode(input.body);
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  const body = renderMarkdown(text, repo);
  const tasks = markdownTasks(body);
  return {
    lines,
    content: html`<div class="card prose">${body}</div>`,
    ...(tasks === undefined
      ? {}
      : {
          summary: `${lines.toLocaleString()} lines · ${tasks.done} of ${tasks.total} done · ${fileSize(input.size)}`,
        }),
  };
}
