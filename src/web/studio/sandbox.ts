/**
 * The one honest line about where a run's code ran: an agent's shell held
 * to the sandbox policy, a deploy's or check's processes held in a cell
 * (`apps/contain.ts`) — or not, and why not. Runs that predate the record
 * say nothing.
 */

import type { Run } from "../../core/runs.ts";
import { html, type Html } from "../html.ts";

export function sandboxLine(run: Run): Html | null {
  if (run.sandboxEnforced === null) return null;
  const agent = run.kind === "agent";
  if (run.sandboxEnforced)
    return html`<p class="muted small" id="run-sandbox">
      ${agent
        ? "Sandboxed: the shell was held to the policy."
        : "Contained: the repository's code ran in a cell of its own, with limits."}
    </p>`;
  return html`<p class="error-note" id="run-sandbox">
    ${agent
      ? "Unsandboxed: the shell ran unrestricted"
      : "Uncontained: the repository's code ran unrestricted"}${run.sandboxNote ===
    ""
      ? ""
      : html` (${run.sandboxNote})`}.
  </p>`;
}
