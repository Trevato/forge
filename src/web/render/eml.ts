/**
 * A mail file (`.eml`) as a message: From, To, Cc, Subject and Date as rows,
 * the plain-text body, then the attachments by name, type and size. HTML is
 * never rendered, only its text; every value is escaped by the template.
 */

import { html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { parseEml } from "./eml-parse.ts";

export function eml(input: RenderInput): Rendered {
  const m = parseEml(input.body);
  if ("error" in m) return { content: html``, lines: 0, fallback: `This file is not drawn as a message: ${m.error}.` };
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const rows = m.headers.map(([k, v]) => html`<div class="status-row"><dt>${k}</dt><dd>${v}</dd></div>`);
  const note = m.fromHtml
    ? html`<p class="muted small">This message has only an HTML part: its text is shown with the tags stripped.</p>`
    : html``;
  const body = m.body === "" ? html`<p class="muted">This message has no text body.</p>` : html`<div class="prose" data-text="message"><pre>${m.body}</pre></div>`;
  const files =
    m.attachments.length === 0
      ? html``
      : html`<h3>Attachments</h3><dl class="status-rows" aria-label="Attachments">${m.attachments.map(
          (a) =>
            html`<div class="status-row"><dt>${a.name}</dt><dd>${a.type} · ${fileSize(a.size)}</dd></div>`,
        )}</dl>`;
  const content = html`<dl class="status-rows" aria-label="${name} headers">${rows}</dl>${note}${body}${files}`;
  const n = m.attachments.length;
  return { content, lines: 0, summary: `message${n > 0 ? ` · ${n} ${n === 1 ? "attachment" : "attachments"}` : ""} · ${fileSize(input.size)}` };
}
