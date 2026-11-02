/**
 * The family as plain data (#425): one answer for the page, the JSON read,
 * the MCP tool and the terminal. Anyone sees the parent; only a site admin
 * sees the children, so the gate lives here and nowhere else.
 */

import type { App } from "../app.ts";
import { parentForgeFor } from "../core/parent_releases.ts";
import { running } from "../kernel/version.ts";
import type { ChildAppsSummary } from "./child-apps.ts";
import { childStandings, parentUpstream, type ChildStanding } from "./heartbeat.ts";
import { listChildren } from "../actions/spawn.ts";
import { hostedChildApps } from "./host.ts";

/** A child as the family shows it: its standing, and what its apps are doing. */
export interface FamilyChild extends ChildStanding {
  /** "1 of 2 apps running — bakery asleep", or null when it was given no apps. */
  readonly apps: string | null;
  /** Where it runs: "own cell", "hosted", or "hosted: <why its cell did not start>". */
  readonly placement: string | null;
}

const REASONS = new Set(["asleep", "failed", "stopped", "deploying"]);

/** One word for why an app is not running; free-text errors read as failing. */
function reason(why: string): string {
  if (why === "not started") return "not deployed";
  return REASONS.has(why) ? why : "failing";
}

/** The one line /family and the terminal share, from the state /forges shows. */
export function appsLine(s: ChildAppsSummary | undefined | null): string | null {
  if (s === undefined || s === null || s.total === 0) return null;
  const head = `${s.running} of ${s.total} ${s.total === 1 ? "app" : "apps"} running`;
  if (s.notRunning.length === 0) return head;
  return `${head} — ${s.notRunning.map((n) => `${n.slug} ${reason(n.why)}`).join("; ")}`;
}

/** "takes updates · 3 commits behind · conflict open", or null when the child said nothing of it. */
export function followLine(c: ChildStanding): string | null {
  const bits: string[] = [];
  if (c.mode !== null) bits.push(c.mode === "take-updates" ? "takes updates" : "tells its owner");
  if (c.upstreamBehind !== null)
    bits.push(c.upstreamBehind === 0 ? "up to date" : `${c.upstreamBehind} ${c.upstreamBehind === 1 ? "commit" : "commits"} behind`);
  if (c.conflict) bits.push("conflict open");
  return bits.length === 0 ? null : bits.join(" · ");
}

export interface FamilyView {
  readonly parent: { readonly url: string; readonly host: string; readonly behind: number | null } | null;
  readonly here: { readonly host: string | null; readonly version: string };
  readonly children: readonly FamilyChild[];
  readonly more: number;
}

export async function familyView(
  app: App,
  isAdmin: boolean,
  appsOf: (app: App, name: string) => ChildAppsSummary | undefined = hostedChildApps,
): Promise<FamilyView> {
  const known = parentForgeFor(app.config);
  const url = app.config.parentUrl ?? (await parentUpstream(app));
  const placed = new Map<string, string>();
  if (isAdmin)
    for (const c of await listChildren(app)) placed.set(c.name, c.placementNote ?? (c.placement === "cell" ? "own cell" : "hosted"));
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
    children: kids.items.map((c) => ({ ...c, apps: appsLine(appsOf(app, c.name)), placement: placed.get(c.name) ?? null })),
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
            c.severedAt !== null ? `follows nothing since ${c.severedAt.slice(0, 10)}` : c.forgeTip === null ? "" : `code at ${c.forgeTip.slice(0, 7)}`,
            c.openProposals === null ? "" : `${c.openProposals} open`,
          ].filter((b) => b !== "");
    // Where it runs, as `/forges` says it: "own cell", "hosted", or why it is hosted.
    if (c.placement !== null) bits.push(c.placement);
    out.push([`child ${c.name}`, bits.join(" · ")]);
    const follow = followLine(c);
    if (follow !== null) out.push(["", follow]);
    if (c.apps !== null) out.push(["", c.apps]);
  }
  if (view.more > 0) out.push(["", `${view.more} more not shown`]);
  return out;
}
