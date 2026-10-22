/**
 * The one honest line about where a run's code ran: an agent's shell held
 * to the sandbox policy, a deploy's or check's processes held in a cell
 * (`apps/contain.ts`) — or not, and why not. Runs that predate the record
 * say nothing.
 */

import type { Run } from "../../core/runs.ts";
import { placementWords } from "../../checks/placement.ts";
import { html, type Html } from "../html.ts";
import { badge } from "../ui.ts";

/** Where a check ran, when that was a cluster job; nothing for the default. */
export function placementLine(run: Run): Html | null {
  const words = placementWords(run);
  return words === "" ? null : html`<p class="muted small" id="run-placement">${words[0]!.toUpperCase() + words.slice(1)}.</p>`;
}

export function sandboxLine(run: Run): Html | null {
  if (run.sandboxEnforced === null) return null;
  const agent = run.kind === "agent";
  if (run.sandboxEnforced)
    return html`<p class="muted small" id="run-sandbox">
      ${agent
        ? "Sandboxed: the shell was held to the policy."
        : "Contained: the repository's code ran in a cell of its own, with limits."}
    </p>`;
  return html`<p class="small" id="run-sandbox">
    ${badge(agent ? "Unsandboxed" : "Uncontained", { tone: "danger" })}
    ${agent
      ? "The shell ran unrestricted"
      : "The repository's code ran unrestricted"}${run.sandboxNote === ""
      ? ""
      : html` (${run.sandboxNote})`}.
  </p>`;
}
