/**
 * The hosts an app's code reached without declaring them, said to the app's
 * writers while egress is only reported (`apps/egress_report.ts`): the list
 * to copy into `forge.json` before the forge starts refusing them.
 */

import { egressModeSentence, undeclaredHosts } from "../../apps/egress_report.ts";
import { egressMode } from "../../apps/contain.ts";
import { html, type Html } from "../html.ts";

export function egressNote(
  dataDir: string,
  repoId: string,
  /** What production declares now: a host declared since is not repeated. */
  declared: readonly string[],
  /** The forge's egress mode now (`core/capacity.ts`). */
  mode: "enforce" | "report" = egressMode(),
): Html | null {
  const { reached, entries } = undeclaredHosts(dataDir, repoId, declared);
  if (reached.length === 0) return null;
  return html`<div class="card" id="app-egress">
    <p class="small">
      This app reached
      ${reached.map(
        (r, i) =>
          html`${i === 0 ? "" : ", "}<code>${r.host}:${r.port}</code>
            <span class="muted">(${r.count}×)</span>`,
      )},
      which <code>forge.json</code> does not declare.
      ${egressModeSentence(mode)}
      Add them to <code>egress</code>:
    </p>
    <pre><code>"egress": ${JSON.stringify(entries)}</code></pre>
  </div>`;
}
