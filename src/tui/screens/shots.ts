/**
 * A pin's screenshots, in the terminal: the list for whoever may read the
 * repository, and for a person who writes it (never an agent) `p` pick from
 * the pictures the forge took of the pin's commit, `c` caption, `u`/`d` move
 * up or down, `x` remove — each through `actions/build_shots.ts`, which
 * checks again and emits `build.shots` for the web. Upload is the API's: a
 * terminal has no file of the person's to send, only the server's own.
 */

import { editShot, pickableLooks, pickShots, removeShot } from "../../actions/build_shots.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { readBuildPin, type BuildPin } from "../../git/builds.ts";
import { repoDir } from "../../git/repos.ts";
import { readShots, type Shots } from "../../git/shots.ts";
import { mayFetchLook } from "../../looks/readable.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, confirmScreen, metaOf, pickerScreen, promptScreen } from "./common.ts";
import { mayPin } from "./builds.ts";

export const NO_SHOTS_LINE = "No screenshots kept with this pin yet.";

const WORDS: Record<string, string> = {
  invalid_caption: "A caption is one line, at most 140 characters.",
  too_many: "A pin keeps at most 12 screenshots.",
  nothing_picked: "Pick at least one picture.",
  no_such_shot: "That screenshot is gone.",
  not_found: "That pin is gone.",
  moved: "The screenshots changed meanwhile; try again.",
  mirrored: "A mirror's builds are its origin's.",
  too_large: "A screenshot is at most 2 MB.",
};
const say = (error: string): string => WORDS[error] ?? "Only a person who writes this repository can do that.";

export function shotsScreen(f: Session, ctx: Ctx, repo: Repo, pin: BuildPin): Screen {
  const dir = repoDir(f.app.reposRoot, repo.ownerName, repo.name);
  let shots: Shots | undefined;
  let hidden = false;
  let note = "";
  const state = new ListState();
  const reload = async (): Promise<void> => {
    shots = await readShots(dir, pin.label);
    state.clamp(shots.items.length);
    ctx.invalidate();
  };
  const done = async (line: string): Promise<void> => {
    note = line;
    await reload();
  };
  const pickable = () => {
    const record = getAppByRepo(f.app.db, repo.id);
    return record === undefined ? [] : pickableLooks(f.app, repo, pin).filter((l) => mayFetchLook(f.app, repo, record, l, f.user));
  };

  const screen: Screen = {
    title: `Screenshots · ${pin.label}`,
    get keys() {
      return [
        binding(["j", "k"], "move"),
        ...(mayPin(f, repo) ? [binding(["p"], "pick"), binding(["c"], "caption"), binding(["u", "d"], "move up/down"), binding(["x"], "remove")] : []),
        binding(["esc", "q"], "back"),
      ];
    },
    async load() {
      hidden = !canRead(f.db, repo, f.user) || (await readBuildPin(dir, pin.label)) === undefined;
      if (hidden) shots = { tree: undefined, items: [] };
      else await reload();
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const right = area.x + area.w;
      const line = (y: number, text: string, fg = c.fg) => s.text(area.x + 1, area.y + y, truncate(text, area.w - 1), style(fg, c.bg), right);
      if (hidden) return void line(0, "No such pin");
      if (shots === undefined) return void line(0, "Reading…");
      const rows = note === "" ? area.h : Math.max(1, area.h - 1);
      if (note !== "") line(area.h - 1, note, c.muted);
      if (shots.items.length === 0) return void line(0, NO_SHOTS_LINE);
      const from = state.window(rows, shots.items.length);
      for (let i = 0; i < rows; i++) {
        const shot = shots.items[from + i];
        if (shot === undefined) break;
        const picked = from + i === state.index;
        s.text(area.x, area.y + i, picked ? ">" : " ", style(c.accent, c.bg), right);
        line(i, `${shot.file}  ${metaOf(shot.type.slice(6), `${Math.ceil(shot.size / 1024)} KB`, shot.caption)}`, picked ? c.fg : c.muted);
      }
    },
    key(e) {
      note = "";
      const count = shots?.items.length ?? 0;
      const current = shots?.items[state.index];
      const write = !e.ctrl && !e.alt && !hidden && mayPin(f, repo);
      const act = (p: Promise<{ readonly ok: boolean; readonly error?: string }>, ok: string): void =>
        void ctx.track(p.then((r) => done(r.ok ? ok : say(r.error ?? ""))));
      if (e.key === "j" || e.key === "down") state.move(1, count);
      else if (e.key === "k" || e.key === "up") state.move(-1, count);
      else if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "p" && write) {
        const looks = pickable();
        if (looks.length === 0) note = "The forge took no pictures of this pin's commit.";
        else
          ctx.push(
            pickerScreen(ctx, screen, {
              title: "Pick pictures",
              multi: true,
              items: looks.map((l) => ({ id: l.id, label: `${l.page} · ${l.kind} · ${l.theme}`, hint: l.env })),
              onPick: (ids) => act(pickShots(f.app, f.user, repo, pin.label, ids), `Kept ${ids.length}.`),
            }),
          );
      } else if (e.key === "c" && write && current !== undefined) {
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Caption ${current.file}`,
            label: "one line, at most 140 characters",
            value: current.caption,
            onSubmit: (text) =>
              ctx.track(editShot(f.app, f.user, repo, pin.label, current.file, { caption: text, at: shots?.tree ?? "" }).then((r) => done(r.ok ? "Captioned." : say(r.error)))),
          }),
        );
      } else if ((e.key === "u" || e.key === "d") && write && current !== undefined) {
        const move = e.key === "u" ? "up" : "down";
        state.move(move === "up" ? -1 : 1, count);
        act(editShot(f.app, f.user, repo, pin.label, current.file, { move, at: shots?.tree ?? "" }), "Moved.");
      } else if (e.key === "x" && write && current !== undefined) {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Remove a screenshot",
            body: [`Remove ${current.file} from ${pin.label}?`],
            actions: [{ label: "Keep", variant: "ghost" }, { label: "Remove", variant: "danger" }],
            onChoose: (i) => {
              if (i >= 1) act(removeShot(f.app, f.user, repo, pin.label, current.file, shots?.tree ?? ""), "Removed.");
            },
          }),
        );
      } else return false;
      ctx.invalidate();
      return true;
    },
  };
  return screen;
}
