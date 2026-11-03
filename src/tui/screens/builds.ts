/**
 * The Builds command, a repository's: its pinned builds, newest first, as
 * the builds page lists them (`listBuildPins`) — label, short commit, who
 * pinned it, when, and the first line of its note. Offered to, and read
 * for, only someone who may read the repository. A person who writes it
 * (never an agent) is also offered `p` pin, `n` note and `d` delete, each
 * through the page's own actions (`pinBuild`, `notePin`, `deletePin`),
 * which check again.
 */

import { deletePin, notePin, pinBuild } from "../../actions/builds.ts";
import { canRead, canWrite, type Repo } from "../../core/repos.ts";
import { listBuildPins, type BuildPin } from "../../git/builds.ts";
import { refTip } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import { nextLabel } from "../../web/pages/builds.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, ago, confirmScreen, metaOf, promptScreen } from "./common.ts";

export const NOT_FOUND_LINE = "No such repository";
export const NO_BUILDS_LINE = "No builds pinned yet.";
export const DELETED_LINE = "Deleted that pin; its commit and notes stay.";

/** What a refused or failed action reads as. */
const WORDS: Record<string, string> = {
  invalid_label: "A label is letters, digits, . _ and -, at most 40.",
  invalid_parent: "That parent is not a pin label.",
  not_a_commit: "That is not a commit in this repository.",
  exists: "That label is already pinned.",
  invalid_note: "A note is plain text, not blank, at most 10 KB.",
  not_found: "That pin is gone.",
  moved: "That pin changed meanwhile; try again.",
  mirrored: "A mirror's builds are its origin's.",
  notes_lost: "The notes ref lost a note; nothing was written.",
};
const say = (error: string): string => WORDS[error] ?? "Only a person who writes this repository can do that.";

/** Whether `f`'s person may pin, note or delete here: a writer who is not an agent. */
export const mayPin = (f: Session, repo: Repo): boolean =>
  f.user !== undefined && f.user.kind !== "agent" && canWrite(f.db, repo, f.user);

/** "label sha note…": the label, then the commit, then the rest as the note. */
export function parsePin(entry: string): { label: string; oid: string; note: string } | undefined {
  const [label = "", oid = "", ...rest] = entry.trim().split(/\s+/);
  return label === "" || oid === "" ? undefined : { label, oid, note: rest.join(" ") };
}

export function buildsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const dir = repoDir(f.app.reposRoot, repo.ownerName, repo.name);
  let pins: BuildPin[] | undefined;
  let hidden = false;
  let note = "";
  const state = new ListState();
  const reload = async (): Promise<void> => {
    pins = await listBuildPins(dir);
    state.clamp(pins.length);
    ctx.invalidate();
  };
  const done = async (line: string): Promise<void> => {
    note = line;
    await reload();
  };

  const pin = async (): Promise<void> => {
    const tip = await refTip(dir, `refs/heads/${repo.defaultBranch}`);
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Pin a build",
        label: "label, commit, then a note",
        value: `${nextLabel(pins ?? [])} ${tip ?? ""} `,
        onSubmit: (entry) => {
          const got = parsePin(entry);
          if (got === undefined) return "Give a label and a commit.";
          return ctx.track(
            pinBuild(f.app, f.user, repo, { ...got, source: "terminal" }).then((r) => done(r.ok ? `Pinned ${r.value.label}.` : say(r.error))),
          );
        },
      }),
    );
  };
  const addNote = (picked: BuildPin): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: `Note on ${picked.label}`,
        label: "what you saw",
        onSubmit: (text) =>
          ctx.track(notePin(f.app, f.user, repo, picked.label, { notes: text }).then((r) => done(r.ok ? `Noted ${picked.label}.` : say(r.error)))),
      }),
    );
  };
  const ask = (picked: BuildPin): void => {
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Delete a pin",
        body: [`Delete the pin ${picked.label}? Its commit and notes stay.`],
        actions: [{ label: "Keep", variant: "ghost" }, { label: "Delete", variant: "danger" }],
        onChoose: (i) => {
          if (i < 1) return;
          void ctx.track(deletePin(f.app, f.user, repo, picked.label).then((r) => done(r.ok ? DELETED_LINE : say(r.error))));
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Builds",
    // Read each time: someone who loses write access stops being offered the writes.
    get keys() {
      return [
        binding(["j", "k"], "move"),
        ...(mayPin(f, repo) ? [binding(["p"], "pin"), binding(["n"], "note"), binding(["d"], "delete")] : []),
        binding(["esc", "q"], "back"),
      ];
    },
    async load() {
      // Gated here as well as on the command: the screen is exported.
      hidden = !canRead(f.db, repo, f.user);
      if (hidden) pins = [];
      else await reload();
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const right = area.x + area.w;
      const line = (y: number, text: string, fg = c.fg) => s.text(area.x + 1, area.y + y, truncate(text, area.w - 1), style(fg, c.bg), right);
      if (hidden) return void line(0, NOT_FOUND_LINE);
      if (pins === undefined) return void line(0, "Reading…");
      const rows = note === "" ? area.h : Math.max(1, area.h - 1);
      if (note !== "") line(area.h - 1, note, c.muted);
      if (pins.length === 0) return void line(0, NO_BUILDS_LINE);
      const from = state.window(rows, pins.length);
      for (let i = 0; i < rows; i++) {
        const p = pins[from + i];
        if (p === undefined) break;
        const picked = from + i === state.index;
        s.text(area.x, area.y + i, picked ? ">" : " ", style(c.accent, c.bg), right);
        const first = p.note.split("\n")[0] ?? "";
        line(i, `${p.label}  ${metaOf(p.oid.slice(0, 7), p.pinnedBy, ago(p.pinnedAt), first === p.label ? "" : first)}`, picked ? c.fg : c.muted);
      }
    },
    key(e) {
      note = "";
      const picked = pins?.[state.index];
      const write = !e.ctrl && !e.alt && !hidden && mayPin(f, repo);
      if (e.key === "j" || e.key === "down") state.move(1, pins?.length ?? 0);
      else if (e.key === "k" || e.key === "up") state.move(-1, pins?.length ?? 0);
      else if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "p" && write) void ctx.track(pin());
      else if (e.key === "n" && write && picked !== undefined) addNote(picked);
      else if (e.key === "d" && write && picked !== undefined) ask(picked);
      else return false;
      ctx.invalidate();
      return true;
    },
  };
  return screen;
}

/** The palette's door on a repository screen, for whoever may read it. */
export function buildsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !canRead(f.db, repo, f.user)) return [];
  return [
    {
      id: "builds",
      title: `${repo.ownerName}/${repo.name} — Builds`,
      hint: "its pinned builds; a writer pins, notes and deletes",
      run: () => ctx.push(buildsScreen(f, ctx, repo)),
    },
  ];
}
