/**
 * A pull's step on the one path (#7703) as a row or a post wears it: the
 * word, linked to /pipeline, and the sentence beside it. The words come
 * from `src/flow/path.ts`; this only draws them.
 */

import { stepWord, type PathStep } from "../../flow/path.ts";
import { html, type Html } from "../html.ts";

export function stepLink(p: Pick<PathStep, "step" | "why">): Html {
  return html`<span class="small muted" data-step="${p.step}"><a href="/pipeline" title="${p.why}">${stepWord(p.step)}</a> · ${p.why}</span>`;
}
