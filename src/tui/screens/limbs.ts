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
 * `w` watches the milestone under the cursor, or stops (#7236): the same
 * `watchMilestone` the page and MCP `watch` reach, so its feed item and its
 * one push follow. A person only; an agent is told so. A watched row reads
 * "watching".
 *
 * Under a limb the planner has answered, the screen says what it changed
 * (owner facts only, as the page): `Re-planned <time ago>` and a line per
 * split, `#old title → #new, #new`. `tab` moves the cursor onto those lines,
 * `j`/`k` scroll them (the header counts any out of view), `enter` opens the
 * new issue, or a choice among them when the line has several, `tab` or `esc`
 * goes back. The block takes at most half the screen below the header.
 *
 * `enter` on a limb that has limbs of its own opens them, so a milestone's
 * sub-limbs can be moved among themselves (the `under` of the action).
 * Subscribed to the bus while on the stack, so a move made on the web, or in
 * another terminal, reorders the list here.
 */

import { undoFleetOp } from "../../actions/fleet.ts";
import { previewReplan, replanLimb, replanResult, takeBackLimb } from "../../actions/limb_replan.ts";
import { IN_HAND } from "../../actions/plan_words.ts";
import { MILESTONE_WATCH_PERSON_ONLY } from "../../actions/board_words.ts";
import { watchMilestone } from "../../actions/watches.ts";
import { isWatching } from "../../core/watches.ts";
import { pendingReplans } from "../../core/limb_replan.ts";
import { applyLimb, previewLimb, type LimbPreview } from "../../actions/limbs.ts";
import { canAdmin, canRead, canSeeOwnerFacts, getRepoById, type Repo } from "../../core/repos.ts";
import { readPlan, type Limb, type Milestone, type Plan } from "../../core/milestones.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { type Pace } from "../../core/pace.ts";
import type { Session } from "../session.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";
import {
  ListState,
  ago,
  confirmScreen,
  drawList,
  hitList,
  live,
  pickerScreen,
  plural,
  runAsync,
  type ListRow,
} from "./common.ts";

/** What reorders or reshapes the limbs: a move, or an issue opening or closing. */
const LIVE_KINDS = ["limb.moved", "limb.replan", "limb.replan_taken_back", "issue.opened", "issue.closed", "issue.reopened"];

/** How many lines of the new order and of the ready list a preview shows. */
const SHOWN = 6;

/** The limbs of `group` (`top`, or a milestone's number), in their set order. */
function limbsOf(plan: Plan, group: string): Limb[] | undefined {
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

/** The most split lines drawn at once; `j` and `k` scroll the rest into view. */
const SPLITS_SHOWN = 4;

type Splits = NonNullable<ReturnType<typeof replanResult>>;

/**
 * What the planner changed on a limb, as the lines under the list: a header,
 * then `#old title → #new, #new` per split, a window of at most `room - 1` of
 * them that follows `at`. The header says how many are out of view. Nothing
 * when there is no room for a header and a line.
 */
export function replanLines(
  r: Splits,
  room: number,
  at = 0,
): { lines: string[]; start: number; shown: number } {
  const n = r.splits.length;
  const shown = Math.min(n, SPLITS_SHOWN, room - 1);
  // Too little room for a line: say so in the header rather than draw nothing.
  if (shown < 1)
    return {
      lines: room < 1 ? [] : [`Re-planned ${ago(r.at)} · ${plural(n, "split")}, too little room to list`],
      start: 0,
      shown: 0,
    };
  const start = Math.max(0, Math.min(at - (shown - 1), n - shown));
  const more = n > shown ? ` · +${n - shown} more` : "";
  const lines = [`Re-planned ${ago(r.at)}${more}`];
  for (const s of r.splits.slice(start, start + shown))
    lines.push(`#${s.number} ${s.title} → ${s.into.map((p) => `#${p.number}`).join(", ")}`);
  return { lines, start, shown };
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** Issues closed per day as block characters, scaled to the largest day; all quiet is the lowest block. */
export function paceSpark(days: readonly number[]): string {
  const top = Math.max(1, ...days);
  return days.map((n) => BLOCKS[Math.min(7, Math.floor((Math.max(0, n) / top) * 8))]).join("");
}

/** The pace line for `width` cells: sparkline, then the sentence; the sparkline goes first when narrow. */
export function paceText(pace: Pace | undefined, width: number): string {
  if (pace === undefined || pace.line === "" || width <= 0) return "";
  const spark = paceSpark(pace.closedPerDay);
  const both = `${spark} ${pace.line}`;
  return both.length <= width ? both : truncate(pace.line, width);
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
  /** Each limb's pace line, by issue number: on pace for a date, no movement, or done. */
  let paces = new Map<number, Pace>();
  /** The receipt of the last move made here, which `u` reverses once. */
  let last: string | undefined;
  /** The limbs with the planner, by issue id (#761). */
  let withPlanner = new Set<string>();
  /** What the planner changed on each answered limb here, by issue number; owner facts only. */
  let replanned = new Map<number, Splits>();
  /** The split line the cursor is on while `tab` has moved it under the list; else undefined. */
  let splitAt: number | undefined;
  /** How many split lines the last render had room to draw; `tab` needs one. */
  let splitsDrawn = 0;
  /** The milestones here the viewer watches, by issue id (#7236). */
  let watching = new Set<string>();
  // Read at use, not at open: a repository's admin can change under a session.
  const may = (): boolean =>
    f.user !== undefined && f.user.kind === "user" && canAdmin(f.db, repo, f.user);

  const reload = (follow?: number): void => {
    if (!canRead(f.db, repo, f.user)) {
      limbs = [];
      spends = new Map();
      paces = new Map();
      replanned = new Map();
      splitAt = undefined;
      loaded = true;
      ctx.invalidate();
      return;
    }
    const plan = readPlan(f.db, repo, { spend: canSeeOwnerFacts(f.db, repo, f.user) });
    limbs = limbsOf(plan, group) ?? [];
    withPlanner = new Set(pendingReplans(f.db, repo).map((r) => r.limbId));
    spends = new Map();
    paces = new Map();
    replanned = new Map();
    watching = new Set();
    const owner = canSeeOwnerFacts(f.db, repo, f.user);
    for (const l of limbs) {
      const r = owner ? replanResult(f.app, repo, l.issue.id) : undefined;
      if (r !== undefined && r.splits.length > 0) replanned.set(l.issue.number, r);
      const m = plan.milestone(l.issue.number);
      if (m === undefined) continue;
      if (f.user?.kind === "user" && isWatching(f.db, f.user.id, m.issue.id))
        watching.add(m.issue.id);
      if (m.spend !== undefined) spends.set(l.issue.number, m.spend);
      if (m.pace.line !== "") paces.set(l.issue.number, m.pace);
    }
    loaded = true;
    if (follow !== undefined) {
      const at = limbs.findIndex((l) => l.issue.number === follow);
      if (at >= 0) state.index = at;
    }
    state.clamp(limbs.length);
    splitAt = undefined;
    ctx.invalidate();
  };

  const splitsHere = (): Splits["splits"] => {
    const l = current();
    return (l === undefined ? undefined : replanned.get(l.issue.number))?.splits ?? [];
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

  /** Watch the milestone under the cursor, or stop: the action decides who may. */
  const watch = (): void => {
    const limb = current();
    if (limb === undefined) return;
    const on = !watching.has(limb.issue.id);
    // Read now, not at open: a repository made private under the screen is not watched.
    const now = getRepoById(f.db, repo.id);
    const done =
      now === undefined
        ? ({ ok: false, error: "not_found" } as const)
        : watchMilestone(f.app, f.user, now, limb.issue.number, on);
    if (!done.ok) {
      ctx.toast(
        done.error === "forbidden" ? MILESTONE_WATCH_PERSON_ONLY : "no milestone to watch here",
        "danger",
      );
      return;
    }
    reload(limb.issue.number);
    ctx.toast(done.value.watching ? "watching — one item in your feed" : "not watching", "success");
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
    if ((limbsOf(readPlan(f.db, repo), String(number)) ?? []).length === 0) return;
    ctx.push(limbsScreen(f, ctx, repo, String(number), limb.name));
  };

  /** One row per limb; a limb with a pace says it in a note under the row, `width` cells wide. */
  const rows = (width: number): ListRow[] =>
    limbs.map((l, n) => ({
      note: paceText(paces.get(l.issue.number), width),
      title: `${n + 1}. ${line(l.issue.number, l.name)}`,
      secondary: withPlanner.has(l.issue.id) ? "with the planner" : l.deferred ? "deferred" : "",
      meta: `${watching.has(l.issue.id) ? "watching · " : ""}${l.weight.done}/${l.weight.total} done`,
    }));

  const screen: Screen = {
    title: name,
    get keys() {
      const moves = may() && limbs.length > 1;
      return [
        binding(["j", "k"], "move cursor"),
        binding(["enter"], splitAt === undefined ? "open" : "open the new issue"),
        binding(["tab"], splitAt === undefined ? "splits" : "limbs", { disabled: splitsDrawn === 0 }),
        binding(["r"], "raise", { disabled: !moves }),
        binding(["l"], "lower", { disabled: !moves }),
        binding(["p"], withPlanner.has(current()?.issue.id ?? "") ? "take back" : "re-plan", { disabled: !may() || current() === undefined }),
        binding(["w"], watching.has(current()?.issue.id ?? "") ? "unwatch" : "watch", { disabled: current() === undefined }),
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
      const answered = current() === undefined ? undefined : replanned.get(current()!.issue.number);
      const fixed = spend ? 2 : 0;
      // The foot never takes more than half of what the header leaves.
      const block =
        answered === undefined
          ? { lines: [], start: 0, shown: 0 }
          : replanLines(answered, Math.max(0, ((area.h - 1) >> 1) - fixed), splitAt);
      splitsDrawn = block.shown;
      if (block.shown === 0) splitAt = undefined;
      const [head, list, foot] = split(area, "v", [
        len(1),
        fill(1),
        len(fixed + block.lines.length),
      ]);
      const note = !loaded
        ? "Loading…"
        : limbs.length === 0
          ? "Nothing here waits for anything yet, so there is no milestone to show."
          : `${plural(limbs.length, "limb")} in the order the crew takes ready work${may() ? "" : " · you can read this order, not change it"}`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows(list!.w - 5));
      const lines = [
        ...(spend === undefined ? [] : spendLines(spend)),
        ...block.lines,
      ];
      // The split lines are the last ones; the header sits above them.
      const first = lines.length - block.shown;
      lines.forEach((text, n) => {
        const on = splitAt !== undefined && n === first + splitAt - block.start;
        const cell = on ? style(c.fg, c.bg, 1) : style(c.mutedFg, c.bg);
        s.text(foot!.x, foot!.y + n, truncate(on ? `> ${text}` : text, foot!.w), cell, foot!.x + foot!.w);
      });
      hitList(ctx, list!, state, limbs.length, { open });
    },
    key(e) {
      const parts = splitsHere();
      if (splitAt !== undefined && !e.ctrl && !e.alt) {
        if (e.key === "j" || e.key === "down") splitAt = Math.min(parts.length - 1, splitAt + 1);
        else if (e.key === "k" || e.key === "up") splitAt = Math.max(0, splitAt - 1);
        else if (e.key === "enter") {
          const into = parts[splitAt]?.into ?? [];
          const show = (number: number): void =>
            ctx.push(issueScreen(f, ctx, local(f, repo), number));
          if (into.length === 1) show(into[0]!.number);
          else if (into.length > 1)
            ctx.push(
              pickerScreen(ctx, screen, {
                title: `#${parts[splitAt]!.number} became`,
                items: into.map((p) => ({ id: String(p.number), label: `#${p.number} ${p.title}` })),
                onPick: ([chosen]) => {
                  if (chosen !== undefined) show(Number(chosen));
                },
              }),
            );
        } else if (e.key === "tab" || e.key === "esc") splitAt = undefined;
        else return false;
        ctx.invalidate();
        return true;
      }
      if (e.key === "tab" && !e.ctrl && !e.alt && parts.length > 0) {
        splitAt = 0;
        ctx.invalidate();
        return true;
      }
      if (state.key(e, limbs.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "enter") open();
      else if (e.key === "r") move("raise");
      else if (e.key === "l") move("lower");
      else if (e.key === "p") replan();
      else if (e.key === "w") watch();
      else if (e.key === "u") undo();
      else return false;
      return true;
    },
  };
  return screen;
}
