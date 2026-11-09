/**
 * A JSON, YAML or TOML config file on the blob page: its values as a form,
 * read-only, with "Edit as form" one click away (`pages/config.ts` is the
 * editor, and draws the schema the file names). A file that is not valid says
 * why, at which line, above its text; Source keeps its highlighted view.
 */

import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";
import { configFields, countFields, MAX_FIELDS } from "./config-form.ts";
import { languageOf, parseConfig } from "./config-format.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/**
 * `/:owner/:name/media/:ref/*path` → `/:owner/:name/config/:ref/*path`: the
 * ref is encoded whole, so the last `/media/` before it is the route's. A
 * mirror's pages (`/origins/…`) edit through the source editor instead.
 */
function editHref(input: RenderInput): string | undefined {
  const head = input.media.slice(0, input.media.length - input.path.length - 1);
  const cut = head.lastIndexOf("/media/");
  if (cut < 0 || head.startsWith("/origins/")) return undefined;
  return `${head.slice(0, cut)}/config/${head.slice(cut + "/media/".length)}/${input.path}`;
}

function brokenConfig(language: string, text: string, line: number, column: number, message: string): Html {
  const lines = text.split("\n");
  return html`<p>Not valid ${language}: ${message} at line ${String(line)}, column ${String(column)}.
      <span class="muted small">The form needs valid ${language}.</span></p>
    <pre class="mono config-diff" tabindex="0" aria-label="Source">${lines.map((l, i) =>
      i + 1 === line ? html`<mark data-op="del">${l}</mark>\n` : `${l}\n`,
    )}</pre>`;
}

export function config(input: RenderInput): Rendered {
  const text = new TextDecoder().decode(input.body);
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  const language = languageOf(input.path);
  const parsed = parseConfig(input.path, text);
  if (!parsed.ok) {
    const e = parsed.error;
    return { lines, content: brokenConfig(language, text, e.line, e.column, e.message) };
  }
  if (countFields(parsed.value) > MAX_FIELDS)
    return {
      lines,
      content: html`<div class="card"><p class="muted">This file has more than ${MAX_FIELDS.toLocaleString()} values, too many for a form. Source shows it whole.</p></div>`,
    };
  const edit = editHref(input);
  return {
    lines,
    content: html`<div class="card config-form">
      <div class="bar mb">
        <span class="muted small">Settings in this file</span><span class="spacer"></span>
        ${edit === undefined ? null : btn("Edit as form", { href: edit, size: "sm", variant: "outline", icon: "pencil" })}
      </div>
      ${configFields(parsed.value, { readonly: true })}
    </div>`,
  };
}
