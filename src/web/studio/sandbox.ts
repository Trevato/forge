/**
 * The one honest line about an agent run's shell: held to the sandbox policy,
 * or not, and why not. Runs that predate the record say nothing.
 */

import type { Run } from "../../core/runs.ts";
import { html, type Html } from "../html.ts";

export function sandboxLine(run: Run): Html | null {
  if (run.kind !== "agent" || run.sandboxEnforced === null) return null;
  if (run.sandboxEnforced)
    return html`<p class="muted small" id="run-sandbox">Sandboxed: the shell was held to the policy.</p>`;
  return html`<p class="error-note" id="run-sandbox">
    Unsandboxed: the shell ran unrestricted${run.sandboxNote === "" ? "" : html` (${run.sandboxNote})`}.
  </p>`;
}
