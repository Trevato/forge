/**
 * What the website specification found on a pull's preview (#2955), beside
 * its checks line: the count, and folded, one row per finding with its
 * specification.website section. Report-only: the words never say failed.
 */

import { html, type Html } from "../html.ts";
import type { Finding } from "../../release/webspec.ts";
import { findingsWords } from "../../core/preview_findings.ts";
import { disclosure } from "../ui.ts";

const sectionName = (url: string): string => url.slice(url.indexOf("#") + 1) || url;

export function specFindings(found: readonly Finding[]): Html {
  if (found.length === 0) return html`<p class="muted">Website spec: no findings on the preview.</p>`;
  const words = findingsWords(found);
  return disclosure(
    `${words[0]!.toUpperCase() + words.slice(1)} (report only)`,
    html`<ul class="list">
      ${found.map(
        (f) =>
          html`<li class="row"><span class="mono">${f.path}</span> ${f.message} —
            <a href="${f.section}" rel="noopener">${sectionName(f.section)}</a>${f.edge
              ? html` <span class="muted">(the edge owns this)</span>`
              : ""}</li>`,
      )}
    </ul>`,
  );
}
