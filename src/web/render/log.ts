/** A terminal log (.log, .ansi) with its colours, laid out as the code view is. */

import { html, raw } from "../html.ts";
import { rowsMarkup } from "../code_rows.ts";
import { btn, empty } from "../ui.ts";
import { ansiLines } from "./ansi.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** The same windows the plain-text view draws: first lines, then up to the ceiling. */
const FIRST_LINES = 1_500;
const MAX_LINES = 10_000;

/** Whether a body holds an escape at all; one without is shown as plain text. */
export const hasEscape = (body: Uint8Array): boolean => body.includes(0x1b);

export function log(input: RenderInput): Rendered {
  const { lines, total } = ansiLines(new TextDecoder().decode(input.body), input.all ? MAX_LINES : FIRST_LINES);
  const cut = total - lines.length;
  const href = input.pathHref ?? "";
  return {
    lines: total,
    content: html`<div class="card code ansi">
        <table>
          ${raw(rowsMarkup(lines.map(raw)))}
        </table>
      </div>
      ${cut > 0
        ? empty({
            icon: "file",
            title: `${cut.toLocaleString("en-US")} more lines`,
            note: input.all ? "The rest is in the raw file." : "The page draws the first lines so it opens at once.",
            action: input.all ? html`` : btn("Show all lines", { href: `${href}?all=1`, id: "code-cut", icon: "file" }),
          })
        : html``}`,
  };
}
