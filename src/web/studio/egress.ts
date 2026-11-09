/**
 * The hosts an app's code reached without declaring them, said to the app's
 * writers while egress is only reported (`apps/egress_report.ts`): the list
 * to copy into `forge.json` before the forge starts refusing them. A block
 * under a heading, one row per host, in the home page's language (#9971).
 */

import { egressModeSentence, undeclaredHosts } from "../../apps/egress_report.ts";
import { egressMode } from "../../apps/contain.ts";
import { html, type Html } from "../html.ts";
import { row } from "../ui.ts";

export function egressNote(
  dataDir: string,
  repoId: string,
  /** What production declares now: a host declared since is not repeated. */
  declared: readonly string[],
  /** The forge's egress mode now (`core/capacity.ts`). */
  mode: "enforce" | "report" = egressMode(),
): Html | null {
  // Once egress is enforced the forge refuses these calls; the note is for the
  // window before that, when adding them to forge.json still saves the app.
  if (mode === "enforce") return null;
  const { reached, entries } = undeclaredHosts(dataDir, repoId, declared);
  if (reached.length === 0) return null;
  return html`<section class="settings-block" id="app-egress">
    <h2>Reached, not declared</h2>
    <p class="small">
      This app reached these hosts, which <code>forge.json</code> does not declare.
      ${egressModeSentence("report")}
    </p>
    <ul class="list setting-list">
      ${reached.map((r) =>
        row({
          title: html`<code>${r.host}:${r.port}</code>`,
          meta: html`${r.count}× · last ${r.last.slice(0, 10)}`,
        }),
      )}
    </ul>
    <p class="small">Add them to <code>egress</code> in <code>forge.json</code>:</p>
    <pre><code>"egress": ${JSON.stringify(entries)}</code></pre>
  </section>`;
}
