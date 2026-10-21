/**
 * Markdown rendered at write time. A comment is written once and read many
 * times, so the moment it lands its body is rendered into `renderMarkdown`'s
 * cache and the first view of the thread finds it done. Nothing here changes
 * what is rendered: it is the same call, made earlier.
 */

import type { App } from "../app.ts";
import { renderMarkdown } from "./markdown.ts";

export function prerenderComments(app: App): () => void {
  return app.bus.subscribe((event) => {
    if (event.kind !== "issue.commented" && event.kind !== "pull.commented") return;
    const body = event.payload["body"];
    if (typeof body !== "string" || body.trim() === "") return;
    try {
      renderMarkdown(body);
    } catch (error) {
      app.log.warn("could not prerender a comment", { error: String(error) });
    }
  });
}
