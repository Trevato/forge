/**
 * The hosts an app's code reached without declaring them, said to the app's
 * writers while egress is only reported (`apps/egress_report.ts`): the list
 * to copy into `forge.json` before the forge starts refusing them.
 */

import { reachedHosts } from "../../apps/egress_report.ts";
import { egressMode } from "../../apps/contain.ts";
import { hostAllowed } from "../../apps/egress.ts";
import { html, type Html } from "../html.ts";

export function egressNote(
  dataDir: string,
  repoId: string,
  /** What production declares now: a host declared since is not repeated. */
  declared: readonly string[],
): Html | null {
  const reached = reachedHosts(dataDir, repoId).filter(
    (r) => !hostAllowed(declared, r.host, r.port),
  );
  if (reached.length === 0) return null;
  const entries = reached.map((r) =>
    r.port === 80 || r.port === 443 ? r.host : `${r.host}:${r.port}`,
  );
  const unique = [...new Set(entries)];
  return html`<div class="card" id="app-egress">
    <p class="small">
      This app reached
      ${reached.map(
        (r, i) =>
          html`${i === 0 ? "" : ", "}<code>${r.host}:${r.port}</code>
            <span class="muted">(${r.count}×)</span>`,
      )},
      which <code>forge.json</code> does not declare.
      ${egressMode() === "report"
        ? "They were let through while egress is only reported; once it is enforced they are refused."
        : "They were let through while egress was only reported; they are refused now."}
      Add them to <code>egress</code>:
    </p>
    <pre><code>"egress": ${JSON.stringify(unique)}</code></pre>
  </div>`;
}
