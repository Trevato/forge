/**
 * Palette entries that live beside their screen. A screen module exports an
 * `entry`; this list names them in the order the palette offers them, and
 * `forgeCommands` walks it at one position. Screens are imported here, and
 * this module by `forge.ts`, never the reverse.
 */

import type { Ctx } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { entry as access } from "./access.ts";
import { entry as agents } from "./agents.ts";
import { entry as askData } from "./ask_data.ts";
import { entry as archived } from "./archived.ts";
import { entry as audit } from "./audit.ts";
import { entry as appTemplates } from "./app_templates.ts";
import { entry as dotfiles } from "./dotfiles.ts";
import { entry as devices } from "./devices.ts";
import { entry as bets } from "./bets.ts";
import { entry as billing } from "./billing.ts";
import { entry as lapsed } from "./lapsed.ts";
import { entry as codes } from "./codes.ts";
import { entry as boards } from "./boards.ts";
import { entry as drift } from "./drift.ts";
import { entry as captain } from "./captain.ts";
import { entry as bugs } from "./bugs.ts";
import { entry as bulk } from "./bulk.ts";
import { entry as childCredit } from "./childcredit.ts";
import { entry as cloud } from "./cloud.ts";
import { entry as connections } from "./connections.ts";
import { entry as crewHandover } from "./crewhandover.ts";
import { entry as crewSplits } from "./crewsplits.ts";
import { entry as knobs } from "./knobs.ts";
import { entry as displays } from "./displays.ts";
import { entry as disks } from "./disks.ts";
import { entry as domains } from "./domains.ts";
import { entry as edgeOnly } from "./edgeonly.ts";
import { entry as traffic } from "./trafficview.ts";
import { entry as funnelEntry } from "./funnel.ts";
import { entry as featureReview } from "./features.ts";
import { entry as feed } from "./feed.ts";
import { entry as featureFeed } from "./featurefeed.ts";
import { entry as features } from "./featureswitch.ts";
import { entry as forgeView } from "./forgeview.ts";
import { entry as flowsAll } from "./flowsall.ts";
import { entry as front } from "./front.ts";
import { entry as frontMilestones } from "./frontms.ts";
import { entry as forges } from "./forges.ts";
import { entry as forgeReady } from "./forgeready.ts";
import { entry as homePins } from "./home_pins.ts";
import { entry as claimStart } from "./claim_start.ts";
import { entry as invites } from "./invites.ts";
import { entry as billingLinks } from "./billinglinks.ts";
import { entry as planRow } from "./planrow.ts";
import { entry as cores } from "./cores.ts";
import { entry as limits } from "./limits.ts";
import { entry as plans } from "./plans.ts";
import { entry as economics } from "./economics.ts";
import { entry as money } from "./money.ts";
import { entry as loopStalls } from "./loopstalls.ts";
import { entry as footing } from "./footing.ts";
import { entry as waiting } from "./waiting.ts";
import { entry as slowPagesEntry } from "./slowpages.ts";
import { entry as maintenance } from "./maintenance.ts";
import { entry as maintainRuns } from "./maintainruns.ts";
import { entry as dutyBudgets } from "./dutybudgets.ts";
import { entry as dutySwitch } from "./dutyswitch.ts";
import { entry as mirrorPacksEntry } from "./mirrorpacks.ts";
import { entry as packReposEntry } from "./packrepos.ts";
import { modelCeilingEntry, modelGrantEntry } from "./model.ts";
import { entry as orgGrants } from "./orggrants.ts";
import { entry as orgTeams } from "./orgteams.ts";
import { entry as newIssue } from "./newissue.ts";
import { entry as now } from "./nowlist.ts";
import { entry as repos } from "./repolist.ts";
import { entry as originAhead } from "./originahead.ts";
import { entry as owner } from "./owner.ts";
import { entry as people } from "./people.ts";
import { entry as pinned } from "./pinned.ts";
import { entry as profile } from "./profile.ts";
import { entry as quotas } from "./quotas.ts";
import { entry as refused } from "./refused.ts";
import { entry as requests } from "./requests.ts";
import { entry as resilience } from "./resilience.ts";
import { entry as scorecard } from "./scorecard.ts";
import { entry as weekcard } from "./weekcard.ts";
import { entry as scrapes } from "./scrapes.ts";
import { entry as trafficScreenEntry } from "./traffic.ts";
import { entry as returningEntry } from "./returning.ts";
import { entry as securityControls } from "./controls.ts";
import { entry as secrets } from "./secrets.ts";
import { entry as sentinel } from "./sentinel.ts";
import { entry as subscriptions } from "./subscriptions.ts";
import { entry as crewKey } from "./crewkey.ts";
import { entry as crewBudgets } from "./crewbudgets.ts";
import { entry as system } from "./system.ts";
import { entry as teams } from "./teams.ts";
import { entry as telemetry } from "./telemetry.ts";
import { entry as valves } from "./valves.ts";

export interface PaletteEntry {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  /**
   * Ids of the commands it follows, nearest first; the first one the session
   * has wins. Without it, or with none present, the entry goes where
   * `addEntries` is called.
   */
  readonly after?: readonly string[];
  /** Whether this session is offered the entry. */
  offered(session: Session): boolean;
  run(session: Session, ctx: Ctx): void;
}

/** In the order the palette offers them; an entry follows the ones it names in `after`. */
export const ENTRIES: readonly PaletteEntry[] = [
  sentinel,
  boards,
  drift,
  captain,
  askData,
  bugs,
  homePins,
  system,
  loopStalls,
  footing,
  waiting,
  slowPagesEntry,
  telemetry,
  resilience,
  maintenance,
  maintainRuns,
  dutySwitch,
  dutyBudgets,
  mirrorPacksEntry,
  packReposEntry,
  valves,
  access,
  edgeOnly,
  traffic,
  funnelEntry,
  audit,
  securityControls,
  secrets,
  crewSplits,
  knobs,
  crewHandover,
  scorecard,
  weekcard,
  modelGrantEntry,
  modelCeilingEntry,
  people,
  quotas,
  limits,
  plans,
  economics,
  money,
  billing,
  lapsed,
  codes,
  appTemplates,
  devices,
  flowsAll,
  scrapes,
  trafficScreenEntry,
  returningEntry,
  teams,
  orgTeams,
  orgGrants,
  agents,
  archived,
  invites,
  billingLinks,
  planRow,
  cores,
  claimStart,
  requests,
  bulk,
  subscriptions,
  crewKey,
  crewBudgets,
  cloud,
  pinned,
  bets,
  connections,
  domains,
  feed,
  featureReview,
  featureFeed,
  features,
  front,
  owner,
  forges,
  refused,
  forgeReady,
  childCredit,
  originAhead,
  profile,
  dotfiles,
  now,
  frontMilestones,
  forgeView,
  repos,
  displays,
  disks,
  newIssue,
];

/** Put each entry the session is offered into `commands`, after the command it names or at the end. */
export function addEntries(commands: Command[], session: Session, ctx: Ctx): void {
  const placed = new Map<string, number>();
  for (const e of ENTRIES) {
    if (!e.offered(session)) continue;
    const command: Command = { id: e.id, title: e.title, hint: e.hint, run: () => e.run(session, ctx) };
    const anchor = e.after?.find((id) => commands.some((c) => c.id === id));
    if (anchor === undefined) {
      commands.push(command);
      continue;
    }
    const before = placed.get(anchor) ?? 0;
    commands.splice(commands.findIndex((c) => c.id === anchor) + 1 + before, 0, command);
    placed.set(anchor, before + 1);
  }
}
