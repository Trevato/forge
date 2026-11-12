/**
 * The queue in the terminal (#11604): the web page's panel (`web/pages/queue.ts`) from the same
 * reads (`core/growth.ts`, sealed issues left out for this viewer) and the planner's switch, which
 * only a human admin of the repository changes: `o` pauses until they switch it on, `w` until the
 * weekly reset, `t` until a time typed in UTC, `n` switches it on. Each goes through
 * `setPlannerSwitch`, the page's one door, so a web viewer sees it at once.
 */

import { setPlannerSwitch, switchInput, type SwitchInput } from "../../actions/planner_switch.ts";
import { growth, oldest, WHO } from "../../core/growth.ts";
import { PAUSE_STOPS, pauseSentence, pausedUntil } from "../../core/planner_pause.ts";
import { canAdmin, getRepoById, type Repo } from "../../core/repos.ts";
import { sealedScope } from "../../core/sealed.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";

const DAYS = 14;

/** Whether this session may flip the switch: a person who administers the repository, never an agent. */
const mayFlip = (f: Session, repo: Repo): boolean =>
  f.user !== undefined && f.user.kind !== "agent" && canAdmin(f.db, repo, f.user);

/** The screen's lines, pure over the session and the clock. */
export function queueLines(f: Session, repo: Repo, now = new Date()): string[] {
  const scope = sealedScope(f.db, repo, f.user);
  const g = growth(f.db, repo, DAYS, now, scope);
  const age = oldest(f.db, repo.id, scope);
  const until = pausedUntil(f.db, repo.id, now);
  const sum = (pick: (d: (typeof g.days)[number]) => number) => g.days.reduce((s, d) => s + pick(d), 0);
  const opened = sum((d) => d.issuesOpened);
  const closed = sum((d) => d.issuesClosed);
  return [
    `${repo.ownerName}/${repo.name}`,
    "",
    pauseSentence(until) + (until === null ? "" : ` ${PAUSE_STOPS}`),
    "",
    ...g.sentences,
    ...(g.suggest === null ? [] : [g.suggest]),
    "",
    `Issues opened ${opened} · closed ${closed} · net ${opened - closed > 0 ? "+" : ""}${opened - closed} · open now ${g.open.issues}`,
    `Pulls opened ${sum((d) => d.pullsOpened)} · landed ${sum((d) => d.pullsLanded)} · closed unmerged ${sum((d) => d.pullsClosed)} · open now ${g.open.pulls}`,
    `Opened by ${WHO.map((w) => `${w} ${sum((d) => d.openedBy[w])}`).join(" · ")}`,
    ...(age.pull === null ? [] : [`Oldest open pull: #${age.pull.number} ${age.pull.title}`]),
    ...(age.issue === null ? [] : [`Oldest issue not started: #${age.issue.number} ${age.issue.title}`]),
    "",
    ...[...g.days].reverse().map((d) => `${d.day}  ${d.issuesOpened} opened · ${d.issuesClosed} closed`),
  ];
}

export function queueScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const current = (): Repo => getRepoById(f.db, repo.id) ?? repo;
  const flip = (input: SwitchInput): string | undefined => {
    const done = setPlannerSwitch(f.app, f.user, current(), input);
    if (done.ok) ctx.toast(pauseSentence(done.value), "success");
    else ctx.toast(done.error === "invalid" ? "Pick a time in the future, within a year." : "Only the owner switches the planner.", "danger");
    ctx.invalidate();
    return undefined;
  };
  const screen: Screen = {
    title: "Queue",
    get keys() {
      return mayFlip(f, current())
        ? [binding(["o"], "pause until on"), binding(["w"], "pause to weekly reset"), binding(["t"], "pause until a time"), binding(["n"], "switch on")]
        : [];
    },
    render(area, s) {
      const c = ctx.theme.c;
      queueLines(f, current()).forEach((line, i) => {
        if (i < area.h) s.text(area.x, area.y + i, truncate(line, area.w), style(c.fg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (!mayFlip(f, current())) return false;
      if (e.key === "o") return flip({ mode: "owner" }), true;
      if (e.key === "w") return flip({ mode: "week" }), true;
      if (e.key === "n") return flip({ mode: "on" }), true;
      if (e.key === "t") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Pause the planner until",
            label: "A time in UTC",
            placeholder: "2026-11-20T09:00",
            onSubmit: (raw) => {
              const input = switchInput("until", raw);
              if (input !== undefined) flip(input);
              return undefined;
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** The palette's "Queue" while a repository is open: anyone who can read it sees the growth. */
export function queueCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined) return [];
  return [
    {
      id: "queue-growth",
      title: `${repo.ownerName}/${repo.name} — Queue`,
      hint: "is the work growing or shrinking, and the planner's switch",
      run: () => ctx.push(queueScreen(f, ctx, repo)),
    },
  ];
}
