/** The crew card's Governor row (#11459): one row, shared by the repository page and the crew page. */

import type { GovernorSeen } from "../../crew/governed.ts";
import { governorLine } from "../../crew/governed.ts";
import { html, type Html } from "../html.ts";

/** The `<dt>/<dd>` pair for the governor, or null while the crew is off or the reader may not see it. */
export function governorRows(governor: GovernorSeen | undefined): Html | null {
  return governor === undefined ? null : html`<dt>Governor</dt><dd>${governorLine(governor)}</dd>`;
}
