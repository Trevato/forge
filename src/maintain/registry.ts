/** The duties the forge runs: one line per duty file in `duties/`. */

import type { Duty } from "./duty.ts";
import { duty as pullsWaiting } from "./duties/stale_pulls.ts";
import { duty as ruleWatcher } from "./duties/rule_watcher.ts";
import { duty as efficiencyWatcher } from "./duties/efficiency_watcher.ts";
import { duty as flowKeeper } from "./duties/flow_keeper.ts";
import { duty as visitorRetention } from "./duties/visitor_retention.ts";

export const duties: readonly Duty[] = [pullsWaiting, ruleWatcher, efficiencyWatcher, flowKeeper, visitorRetention];
