/**
 * The family as plain data (#425): one answer for the page, the JSON read,
 * the MCP tool and the terminal. Anyone sees the parent; only a site admin
 * sees the children, so the gate lives here and nowhere else.
 */

import type { App } from "../app.ts";
import { parentForgeFor } from "../core/parent_releases.ts";
import { running } from "../kernel/version.ts";
import { childStandings, parentUpstream, type ChildStanding } from "./heartbeat.ts";

export interface FamilyView {
  readonly parent: { readonly url: string; readonly host: string; readonly behind: number | null } | null;
  readonly here: { readonly host: string | null; readonly version: string };
  readonly children: readonly ChildStanding[];
  readonly more: number;
}

export async function familyView(app: App, isAdmin: boolean): Promise<FamilyView> {
  const known = parentForgeFor(app.config);
  const url = app.config.parentUrl ?? (await parentUpstream(app));
  const kids = isAdmin ? await childStandings(app) : { items: [], more: 0 };
  return {
    parent:
      url === undefined
        ? null
        : { url, host: known?.host ?? new URL(url).host, behind: known?.behind ?? null },
    here: {
      host: app.config.url === undefined ? null : new URL(app.config.url).host,
      version: running().version,
    },
    children: kids.items,
    more: kids.more,
  };
}

/** The view as plain lines, for a terminal. */
export function familyLines(view: FamilyView): [string, string][] {
  const out: [string, string][] = [];
  if (view.parent !== null) {
    out.push(["parent", view.parent.url]);
    if (view.parent.behind !== null)
      out.push(["", view.parent.behind === 0 ? "this forge is up to date" : `this forge is ${view.parent.behind} behind`]);
  } else out.push(["parent", "none"]);
  out.push(["this forge", `${view.here.host ?? "here"} · version ${view.here.version}`]);
  for (const c of view.children) {
    const bits =
      c.state === "unheard"
        ? ["has not reported yet"]
        : [
            c.state,
            c.version === null ? "" : `version ${c.version}`,
            c.openProposals === null ? "" : `${c.openProposals} open`,
          ].filter((b) => b !== "");
    out.push([`child ${c.name}`, bits.join(" · ")]);
  }
  if (view.more > 0) out.push(["", `${view.more} more not shown`]);
  return out;
}
