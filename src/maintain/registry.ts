/** The duties the forge runs: one line per duty file in `duties/`. */

import type { Duty } from "./duty.ts";
import { duty as pullsWaiting } from "./duties/stale_pulls.ts";

export const duties: readonly Duty[] = [pullsWaiting];
