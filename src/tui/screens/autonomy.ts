/**
 * A repository's autonomy in the terminal: mode, dollar ceiling and slots, as
 * Settings › Autonomy has them. Like that card it is for whoever administers
 * the repository (`canAdmin`), an agent included, as the page's API lets one:
 * they pick the mode with `m` (a confirm offering Off, Assisted and Autonomous
 * outright, naming what each does and the ceiling that will apply, Cancel
 * selected), the ceiling with `c` and, for each seat of the team, how much it
 * may do at once with `p` (planner), `s` (builder) or `r` (reviewer), 0 pausing
 * it (`setSeatSlots`, the web card's and the MCP's one door); each saves through
 * `updateRepoSettings` with the fields the page writes and toasts the page's
 * flash (`AUTONOMY_SAID`), and a value out of bounds is refused with the
 * page's sentence (`checkAutonomy`).
 * `o` sets the polish share (0–50, #8853) through the same `updateRepoSettings`, so a web viewer sees it live.
 * Anyone else gets no palette entry and, if the screen is reached, no values.
 */

import { updateRepoSettings } from "../../actions/repos.ts";
import { POLISH_SHARE_MAX, validPolishShare } from "../../crew/small_share.ts";
import { seatSlotsSaid, setSeatSlots } from "../../actions/seat_slots.ts";
import { checkSeatSlots, seatSlotsOf, seatSlotsWords } from "../../crew/seat_slots.ts";
import type { CrewRole } from "../../core/agents.ts";
import {
  AUTONOMY,
  AUTONOMY_BOUNDS,
  AUTONOMY_SAID,
  canAdmin,
  checkAutonomy,
  getRepoById,
  type Autonomy,
  type Repo,
} from "../../core/repos.ts";
import type { Command } from "../app/palette.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { confirmScreen, promptScreen } from "./common.ts";

const MODE_LABEL: Record<Autonomy, string> = { off: "Off", assisted: "Assisted", autonomous: "Autonomous" };

const dollars = (n: number): string => `$${n}`;

const mayAdminister = (f: Session, repo: Repo): boolean =>
  f.user !== undefined && canAdmin(f.db, repo, f.user);

/** The palette's "Autonomy", while a repository is open, to its admins. */
export function autonomyCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !mayAdminister(f, repo)) return [];
  return [
    {
      id: "autonomy",
      title: `${repo.ownerName}/${repo.name} — Autonomy`,
      hint: "mode, dollar ceiling and slots of the crew",
      run: () => ctx.push(autonomyScreen(f, ctx, repo)),
    },
  ];
}

export function autonomyScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const current = (): Repo => getRepoById(f.db, repo.id) ?? repo;
  // Whoever administers the repository; the action decides again on save.
  const mayChange = (): boolean => mayAdminister(f, current());

  const save = (patch: { mode?: Autonomy; ceiling?: number; slots?: number }, said: string): void => {
    const now = current();
    const mode = patch.mode ?? now.autonomy;
    const ceiling = patch.ceiling ?? now.autonomyCeilingUsd;
    const slots = patch.slots ?? now.autonomySlots;
    const checked = checkAutonomy(mode, ceiling, slots);
    if (!checked.ok) return void ctx.toast(checked.message, "danger");
    void updateRepoSettings(f.app, f.user, now, {
      autonomy: mode,
      autonomyCeilingUsd: ceiling,
      autonomySlots: slots,
      autonomyBy: mode === "off" ? null : (f.user?.id ?? null),
    }).then(
      (done) => {
        if (done.ok) ctx.toast(said, "success");
        else if (done.error === "not_found") ctx.toast("Only an admin of this repository sets its autonomy.", "danger");
        else ctx.toast("Those settings could not be saved.", "danger");
        ctx.invalidate();
      },
      () => {
        ctx.toast("Those settings could not be saved.", "danger");
        ctx.invalidate();
      },
    );
  };

  const ask = (title: string, label: string, hint: string, value: string, onValue: (raw: string) => string | undefined): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title,
        label,
        value,
        hint,
        onSubmit: (raw) => onValue(raw.trim()),
      }),
    );
  };

  const screen: Screen = {
    title: "Autonomy",
    get keys() {
      return mayChange()
        ? [binding(["m"], "mode"), binding(["c"], "ceiling"), binding(["p"], "planner"), binding(["s"], "builder"), binding(["r"], "reviewer"), binding(["o"], "polish share")]
        : [];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const r = current();
      const lines = !mayChange()
        ? [`${r.ownerName}/${r.name}`, "", "Only an admin of this repository sets its autonomy."]
        : [
            `${r.ownerName}/${r.name}`,
            "",
            `Mode     ${r.autonomy}`,
            `         ${AUTONOMY_SAID[r.autonomy]}`,
            `Ceiling  ${dollars(r.autonomyCeilingUsd)} a day`,
            `Polish   ${r.polishShare}% of the week's spend`,
            ...seatSlotsOf(f.db, r).map(
              (p) => `${(p.role[0]!.toUpperCase() + p.role.slice(1)).padEnd(9)}${p.slots} at once · ${seatSlotsWords(p)}`,
            ),
          ];
      lines.forEach((line, i) => {
        if (i < area.h)
          s.text(area.x, area.y + i, truncate(line, area.w), style(c.fg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (!mayChange()) return false;
      if (e.key === "m") {
        const now = current();
        // Any mode is one pick away, so leaving autonomous never passes
        // through another live mode; Cancel is what Enter does unmoved.
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Set autonomy (now ${now.autonomy})`,
            body: [
              ...AUTONOMY.map((mode) => AUTONOMY_SAID[mode]),
              `The ceiling that applies is ${dollars(now.autonomyCeilingUsd)} a day.`,
            ],
            actions: [
              ...AUTONOMY.map((mode) => ({ label: MODE_LABEL[mode] })),
              { label: "Cancel", variant: "ghost" as const },
            ],
            selected: AUTONOMY.length,
            width: 78,
            onChoose: (choice) => {
              const next = AUTONOMY[choice];
              // The same mode again would only move who it ships as.
              if (next !== undefined && next !== current().autonomy) save({ mode: next }, AUTONOMY_SAID[next]);
            },
          }),
        );
        return true;
      }
      if (e.key === "c") {
        ask("Ceiling", "dollars a day, 0 or more", "0 or more", String(current().autonomyCeilingUsd), (raw) => {
          const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
          save({ ceiling: n }, `Ceiling is ${dollars(n)} a day.`);
          return undefined;
        });
        return true;
      }
      if (e.key === "o") {
        ask("Polish share", `percent of the week's spend, 0 to ${POLISH_SHARE_MAX}`, `0 to ${POLISH_SHARE_MAX}`, String(current().polishShare), (raw) => {
          const n = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
          if (!validPolishShare(n)) return void ctx.toast(`Polish share is a whole number of percent, 0 to ${POLISH_SHARE_MAX}.`, "danger");
          void updateRepoSettings(f.app, f.user, current(), { polishShare: n }).then((done) => {
            ctx.toast(done.ok ? `Polish share is ${n}% of the week's spend.` : "Only an admin of this repository sets its polish share.", done.ok ? "success" : "danger");
            ctx.invalidate();
          });
          return undefined;
        });
        return true;
      }
      const seat: Partial<Record<string, CrewRole>> = { p: "planner", s: "builder", r: "reviewer" };
      const role = seat[e.key];
      if (role !== undefined) {
        const max = role === "planner" ? 1 : 8;
        const slots = seatSlotsOf(f.db, current()).find((p) => p.role === role)!.slots;
        ask(`${role[0]!.toUpperCase()}${role.slice(1)}`, `a whole number, 0 (paused) to ${max}`, `0 to ${max}`, String(slots), (raw) => {
          const checked = checkSeatSlots(role, raw);
          if (checked === undefined) return void ctx.toast(AUTONOMY_BOUNDS, "danger");
          void setSeatSlots(f.app, f.user, current(), role, checked.slots).then((done) => {
            ctx.toast(done.ok ? seatSlotsSaid(role, checked.slots) : "Only an admin of this repository sets its crew.", done.ok ? "success" : "danger");
            ctx.invalidate();
          });
          return undefined;
        });
        return true;
      }
      return false;
    },
  };
  return screen;
}
