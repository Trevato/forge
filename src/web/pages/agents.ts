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
import { html, type Html } from "../html.ts";
import { btn, disclosure, field as formField } from "../ui.ts";
import { page } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { START_BUTTON, SITE_PATH } from "../site_line.ts";
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

/** The guide's first "Start here" bullet, the path with no account, as its first three sentences:
 * the curl that makes the app, the clone and push, the claim link for the person. The page's steps
 * are the guide's own words, so the two never drift. */
export function firstSteps(body: string): string[] {
  const start = body.indexOf("## Start here");
  if (start < 0) return [];
  const bullet = body.slice(start).split("\n").find((l) => l.startsWith("- "));
  if (!bullet) return [];
  const action = bullet.slice(bullet.indexOf(": ") + 2);
  return action.split(/\. (?=[A-Z])/).slice(0, 3).map((s) => s.trim().replace(/\.$/, ""));
}

/** One step's words, each `code span` drawn as code and everything escaped. */
function stepLine(step: string): Html {
  return html`${step.split(/`([^`]*)`/).map((part, i) => (i % 2 === 1 ? html`<code>${part}</code>` : part))}`;
}

/** The whole guide as the page draws it inside the disclosure: the text less its title, each address a link. */
export function guideHtml(body: string): Html {
  return renderMarkdown(linkAddresses(withoutTitle(body)));
}

export function agentsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const { body } = llmsBody(ctx);
  return timePhase(ctx.request, "render", () => page({
    ctx,
    title: "For AI assistants",
    description: SITE_PATH(ctx.url.origin),
    body: html`${pageHead("For AI assistants", {
        sub: html`People start at <a href="/">home</a>. Assistants: <a href="/llms.txt">/llms.txt</a>`,
      })}
      <section class="stack" aria-labelledby="agent-forge-h">
        <h2 id="agent-forge-h">Get a forge of your own</h2>
        <form method="post" action="/forges/start" class="stack" id="agent-forge">
          ${formField({ label: "Name", name: "name", required: true })}
          ${btn(START_BUTTON, { variant: "primary" })}
        </form>
      </section>
      <div class="prose break"><ol id="agent-steps" aria-label="Build an app with no account">${firstSteps(body).map((step) => html`<li>${stepLine(step)}</li>`)}</ol></div>
      ${disclosure("? Full guide", html`<article class="prose prose-page" id="agents-guide">${guideHtml(body)}</article>`, { id: "agents-more" })}`,
  }));
}
