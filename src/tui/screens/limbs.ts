/**
 * The limbs of a repository, in their set order, and Raise and Lower for the
 * person who administers it (#1514).
 *
 * This is the milestones page's door in the terminal, not a second
 * implementation: a move is `previewLimb`, then `applyLimb`, then (if
 * regretted) `undoFleetOp` — the fleet operation the page and the API use,
 * verb `place`. What the screen decides is only what to draw and which keys
 * exist; the action decides who may. A reader sees the order and no keys to
 * change it, an agent likewise, and a guest sees what `canRead` lets the web
 * show — the plan is read without the owner's spend. Whoever may see owner
 * facts (`canSeeOwnerFacts`, as on the page) also gets, under the list, what
 * the limb under the cursor cost and landed, and its costliest issues.
 *
 * `p` hands the limb under the cursor to the planner to re-plan as fewer,
 * larger pieces (#761): `previewReplan` lists what it will be given, then
 * `replanLimb` on confirm. The row reads "with the planner" until it
 * answers, and `p` then takes it back while that is still allowed.
 *
 * `enter` on a limb that has limbs of its own opens them, so a milestone's
 * sub-limbs can be moved among themselves (the `under` of the action).
 * Subscribed to the bus while on the stack, so a move made on the web, or in
 * another terminal, reorders the list here.
 */

import { undoFleetOp } from "../../actions/fleet.ts";
import { previewReplan, replanLimb, takeBackLimb } from "../../actions/limb_replan.ts";
import { IN_HAND } from "../../actions/plan_words.ts";
import { pendingReplans } from "../../core/limb_replan.ts";
import { applyLimb, previewLimb, type LimbPreview } from "../../actions/limbs.ts";
import { canAdmin, canRead, canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { readPlan, type Limb, type Milestone } from "../../core/milestones.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  confirmScreen,
  drawList,
  hitList,
  live,
  plural,
  runAsync,
  type ListRow,
} from "./common.ts";

/** What reorders or reshapes the limbs: a move, or an issue opening or closing. */
const LIVE_KINDS = ["limb.moved", "limb.replan", "limb.replan_taken_back", "issue.opened", "issue.closed", "issue.reopened"];

/** How many lines of the new order and of the ready list a preview shows. */
const SHOWN = 6;

/** The limbs of `group` (`top`, or a milestone's number), in their set order. */
function limbsOf(f: Session, repo: Repo, group: string): Limb[] | undefined {
  const plan = readPlan(f.db, repo);
  if (group === "top") return [...plan.limbs];
  const milestone = plan.milestone(Number(group));
  return milestone === undefined ? undefined : [...milestone.limbs];
}

/** What a limb cost and landed, as the two lines under the list. */
export function spendLines(spend: NonNullable<Milestone["spend"]>): string[] {
  const dear = spend.costliest.map((c) => `#${c.issue.number} $${c.usd.toFixed(2)}`);
  return [
    `Cost and landed: $${spend.usd.toFixed(2)} spent · ${plural(spend.landed, "change")} landed`,
    dear.length === 0 ? "Nothing has cost anything yet." : `Costliest: ${dear.join(" · ")}`,
  ];
}

const line = (n: number, title: string): string => `#${n} ${title}`;

/** What a preview says before anything is written, as dialog lines. */
function previewLines(p: LimbPreview): string[] {
  const out: string[] = ["New order:"];
  const order = p.order ?? [];
  const at = order.findIndex((i) => i.number === p.limb.number);
  // Keep the moved limb in view whatever the length.
  const from = Math.max(0, Math.min(at - 2, order.length - SHOWN));
  order.slice(from, from + SHOWN).forEach((i, n) =>
    out.push(
      `${i.number === p.limb.number ? ">" : " "} ${from + n + 1}. ${line(i.number, i.title)}`,
    ),
  );
  if (order.length > from + SHOWN) out.push(`  … ${order.length - from - SHOWN} more`);
  const before = (p.ready?.before ?? []).map((i) => i.number).join();
  const after = p.ready?.after ?? [];
  out.push("");
  if (after.length === 0) out.push("Nothing is ready.");
  else if (before === after.map((i) => i.number).join())
    out.push(`Ready list unchanged: the same ${after.length} come first.`);
  else {
    out.push("The crew then takes first:");
    for (const i of after.slice(0, 3)) out.push(`  ${line(i.number, i.title)}`);
  }
  return out;
}

export function limbsScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  group = "top",
  name = "Milestones",
): Screen {
  const state = new ListState();
  let limbs: Limb[] = [];
  let loaded = false;
  /** What each limb here cost and landed, by issue number; empty unless owner facts. */
  let spends = new Map<number, NonNullable<Milestone["spend"]>>();
  /** The receipt of the last move made here, which `u` reverses once. */
  let last: string | undefined;
  /** The limbs with the planner, by issue id (#761). */
  let withPlanner = new Set<string>();
  // Read at use, not at open: a repository's admin can change under a session.
  const may = (): boolean =>
    f.user !== undefined && f.user.kind === "user" && canAdmin(f.db, repo, f.user);

  const reload = (follow?: number): void => {
    if (!canRead(f.db, repo, f.user)) {
      limbs = [];
      spends = new Map();
      loaded = true;
      ctx.invalidate();
      return;
    }
    limbs = limbsOf(f, repo, group) ?? [];
    withPlanner = new Set(pendingReplans(f.db, repo).map((r) => r.limbId));
    spends = new Map();
    if (canSeeOwnerFacts(f.db, repo, f.user)) {
      const plan = readPlan(f.db, repo, { spend: true });
      for (const l of limbs) {
        const spend = plan.milestone(l.issue.number)?.spend;
        if (spend !== undefined) spends.set(l.issue.number, spend);
      }
    }
    loaded = true;
    if (follow !== undefined) {
      const at = limbs.findIndex((l) => l.issue.number === follow);
      if (at >= 0) state.index = at;
    }
    state.clamp(limbs.length);
    ctx.invalidate();
  };

  const current = (): Limb | undefined => limbs[state.index];

  const move = (action: "raise" | "lower"): void => {
    const limb = current();
    if (limb === undefined || !may()) return;
    const number = limb.issue.number;
    const request = { action, under: group } as const;
    const plan = previewLimb(f.app, f.user, repo, number, request);
    if (!plan.ok) {
      ctx.toast(plan.error.message, "danger");
      return;
    }
    if (plan.value.counts.change === 0) {
      ctx.toast("nothing to move", "danger");
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `${action === "raise" ? "Raise" : "Lower"} “${limb.name}”?`,
        body: previewLines(plan.value),
        actions: [
          { label: action === "raise" ? "Raise" : "Lower", variant: "default" },
          { label: "Cancel", variant: "ghost" },
        ],
        onChoose: (choice) => {
          if (choice !== 0) return;
          runAsync(ctx, async () => {
            const done = await applyLimb(f.app, f.user, repo, number, request);
            if (!done.ok) {
              ctx.toast(done.error.message, "danger");
              return;
            }
            last = done.value.id;
            reload(number);
            ctx.toast("moved — u undoes it", "success");
          });
        },
      }),
    );
  };

  /** Re-plan: hand the limb to the planner after reading what it is given; or take it back. */
  const replan = (): void => {
    const limb = current();
    if (limb === undefined || !may()) return;
    const number = limb.issue.number;
    const seen = previewReplan(f.app, f.user, repo, number);
    if (!seen.ok) {
      ctx.toast(seen.error.message, "danger");
      return;
    }
    const p = seen.value;
    if (p.withPlanner && !p.takeBack) {
      ctx.toast(IN_HAND, "danger");
      return;
    }
    if (!p.withPlanner && p.blocked !== undefined) {
      ctx.toast(p.blocked, "danger");
      return;
    }
    const taking = p.withPlanner;
    const body = [
      taking
        ? "It is with the planner; nothing beneath it is picked. Take it back before the planner starts:"
        : `The planner will be given ${plural(p.issues.length, "issue")}, to close as split into fewer, larger ones:`,
      ...p.issues.slice(0, SHOWN).map((i) => `  ${line(i.number, i.title)}`),
      ...(p.issues.length > SHOWN ? [`  … ${p.issues.length - SHOWN} more`] : []),
    ];
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `${taking ? "Take back" : "Re-plan"} “${limb.name}”?`,
        body,
        actions: [
          { label: taking ? "Take it back" : "Hand to the planner", variant: "default" },
          { label: "Cancel", variant: "ghost" },
        ],
        onChoose: (choice) => {
          if (choice !== 0) return;
          const done = taking
            ? takeBackLimb(f.app, f.user, repo, number)
            : replanLimb(f.app, f.user, repo, number);
          if (!done.ok) {
            ctx.toast(done.error.message, "danger");
            return;
          }
          reload(number);
          ctx.toast(taking ? "taken back" : "with the planner", "success");
        },
      }),
    );
  };

  const undo = (): void => {
    const id = last;
    if (id === undefined || !may()) return;
    runAsync(ctx, async () => {
      const done = await undoFleetOp(f.app, f.user, id);
      last = undefined;
      if (!done.ok) {
        ctx.toast(done.error.message, "danger");
        return;
      }
      reload();
      ctx.toast("undone", "success");
    });
  };

  const open = (): void => {
    const limb = current();
    if (limb === undefined) return;
    const number = limb.issue.number;
    // Only a limb with limbs of its own has anything to open.
    if ((limbsOf(f, repo, String(number)) ?? []).length === 0) return;
    ctx.push(limbsScreen(f, ctx, repo, String(number), limb.name));
  };

  const rows = (): ListRow[] =>
    limbs.map((l, n) => ({
      title: `${n + 1}. ${line(l.issue.number, l.name)}`,
      secondary: withPlanner.has(l.issue.id) ? "with the planner" : l.deferred ? "deferred" : "",
      meta: `${l.weight.done}/${l.weight.total} done`,
    }));

  const screen: Screen = {
    title: name,
    get keys() {
      const moves = may() && limbs.length > 1;
      return [
        binding(["j", "k"], "move cursor"),
        binding(["enter"], "open"),
        binding(["r"], "raise", { disabled: !moves }),
        binding(["l"], "lower", { disabled: !moves }),
        binding(["p"], withPlanner.has(current()?.issue.id ?? "") ? "take back" : "re-plan", { disabled: !may() || current() === undefined }),
        binding(["u"], "undo", { disabled: !may() || last === undefined }),
      ];
    },
    load(signal) {
      live(f, signal, { repoId: repo.id, kinds: LIVE_KINDS }, () => reload());
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const spend = current() === undefined ? undefined : spends.get(current()!.issue.number);
      const [head, list, foot] = split(area, "v", [len(1), fill(1), len(spend ? 2 : 0)]);
      const note = !loaded
        ? "Loading…"
        : limbs.length === 0
          ? "Nothing here waits for anything yet, so there is no milestone to show."
          : `${plural(limbs.length, "limb")} in the order the crew takes ready work${may() ? "" : " · you can read this order, not change it"}`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
      if (spend !== undefined)
        spendLines(spend).forEach((text, n) =>
          s.text(foot!.x, foot!.y + n, truncate(text, foot!.w), style(c.mutedFg, c.bg), foot!.x + foot!.w),
        );
      hitList(ctx, list!, state, limbs.length, { open });
    },
    key(e) {
      if (state.key(e, limbs.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "enter") open();
      else if (e.key === "r") move("raise");
      else if (e.key === "l") move("lower");
      else if (e.key === "p") replan();
      else if (e.key === "u") undo();
      else return false;
      return true;
    },
  };
  return screen;
}
