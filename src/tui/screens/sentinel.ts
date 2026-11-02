/** The Sentinel palette entry. */

import type { PaletteEntry } from "./entries.ts";
import { sentinelSummary } from "../../crew/sentinel.ts";

/** The forge's own faults, as the board's strip shows them: a site admin's. */
export const entry: PaletteEntry = {
  id: "sentinel",
  title: "Sentinel",
  hint: "the forge's open faults",
  after: ["signins"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.toast(sentinelSummary(session.db) ?? "The sentinel has not hunted yet", "default"),
};
