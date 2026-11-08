/**
 * GET /agents: /llms.txt as a page. Some assistants' readers turn away a
 * plain-text or Markdown file given in a prompt and read only HTML, so the
 * home page's Open-in links point here. The words are the same text, from
 * the same source (`llmsBody`), so the two never drift; this page only draws
 * it and links each address.
 */

import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { pageHead } from "../chrome.ts";
import { html } from "../html.ts";
import { btn, field as formField } from "../ui.ts";
import { page } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { llmsBody } from "../standards.ts";

/** An address in prose, outside code, made a link; a template (`{owner}`) stays words. */
const URL = /https?:\/\/[A-Za-z0-9][^\s<>`"()\]]*/g;

/** Each bare address in the Markdown made a link, leaving code spans as they are. */
export function linkAddresses(source: string): string {
  return source
    .split(/(`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(URL, (found) => {
            const url = found.replace(/[.,;:!?]+$/, "");
            if (url.includes("{")) return found;
            return `[${url}](${url})${found.slice(url.length)}`;
          }),
    )
    .join("");
}

/** The text less its first heading: the page has its own. */
function withoutTitle(body: string): string {
  return body.replace(/^# .*\n+/, "");
}

export function agentsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const { body } = llmsBody(ctx);
  return timePhase(ctx.request, "render", () => page({
    ctx,
    title: "For AI assistants",
    description:
      "What this forge is and how an AI assistant can help you use it: build one of its public apps, report a problem, or get a forge of your own.",
    body: html`${pageHead("For AI assistants", {
        sub: html`What this forge is, and the steps an assistant can take for you, or tell you to take. The same
          words as plain text: <a href="/llms.txt">/llms.txt</a>.`,
      })}
      <section class="stack" aria-labelledby="agent-forge-h">
        <h2 id="agent-forge-h">Get a forge of your own</h2>
        <p class="muted small">Free within limits while hosting is not sold. It sleeps when idle and wakes on its next visit; bring your own model credential or its crew stays off.</p>
        <form method="post" action="/forges/new" class="stack" id="agent-forge">
          ${formField({ label: "Name", name: "name", required: true })}
          ${btn("Make my forge", { variant: "primary" })}
        </form>
      </section>
      <article class="prose prose-page" id="agents-guide">${renderMarkdown(linkAddresses(withoutTitle(body)))}</article>`,
  }));
}
