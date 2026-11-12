/**
 * The Labels command, a repository's (#7841): each label the repository
 * defines, as the issue screen draws it — the colour chip, then its hex —
 * read with `listLabels`, name order. A repository admin also sees how many
 * open issues and pulls carry each (`openLabelCounts`: `N open` / `unused`),
 * and the delete confirm names that count. Offered to, and read for, only
 * someone who may read the repository.
 */

import { LABEL_WORDS } from "../../actions/label_words.ts";
import { requireRepoAdmin } from "../../actions/access.ts";
import { createLabel, deleteLabel, updateLabel } from "../../actions/repos.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { listLabels, openLabelCounts, type Label } from "../../core/issues.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { ListState, confirmScreen, promptScreen } from "./common.ts";
import { labelChip } from "../ui/widgets.ts";
import type { Session } from "../session.ts";

/** What a viewer who may not read the repository sees: what the page's 404 says. */
export const NOT_FOUND_LINE = "No such repository";
export const NOT_ALLOWED_LINE = "Only a repository admin can change a label.";
export const NO_LABELS_LINE = "No labels yet.";
export const DELETED_LINE = "Deleted that label.";
export const GONE_LINE = "That label is already gone, or you can no longer delete it.";

export function labelsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let labels: Label[] | undefined;
  let hidden = false;
  /** Open items per label id; empty for a viewer who is not an admin. */
  let counts = new Map<string, number>();
  const state = new ListState();
  let note = "";
  // Only whoever `requireRepoAdmin` admits is offered `n`.
  const admin = (): boolean => requireRepoAdmin(f.app, f.user, repo).ok;

  const reload = (): void => {
    labels = listLabels(f.db, repo.id);
    counts = admin() ? openLabelCounts(f.db, repo.id) : new Map();
  };
  const usage = (l: Label): string => ((counts.get(l.id) ?? 0) > 0 ? `${counts.get(l.id)} open` : "unused");

  /** "name hex": the last word is the colour; a leading `#` is allowed. */
  const parse = (entry: string): { name: string; hex: string } | undefined => {
    const words = entry.trim().split(/\s+/);
    const hex = (words.pop() ?? "").replace(/^#/, "");
    const name = words.join(" ");
    return name === "" || !/^[0-9a-fA-F]{6}$/.test(hex) ? undefined : { name, hex: hex.toLowerCase() };
  };
  const refusal = (error: string): string =>
    error === "taken" ? LABEL_WORDS.taken : error === "invalid" ? LABEL_WORDS.shape : NOT_ALLOWED_LINE;
  const make = (entry: string): string | undefined => {
    const got = parse(entry);
    if (got === undefined) return LABEL_WORDS.shape;
    const made = createLabel(f.app, f.user, repo, got.name, got.hex);
    if (!made.ok) return refusal(made.error);
    reload();
    ctx.invalidate();
    return undefined;
  };
  /** The same form as `n`, prefilled with the label's name and colour. */
  const rename = (picked: Label): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Edit label",
        label: "name and six hex digits (bug d73a4a)",
        value: `${picked.name} ${picked.color.replace(/^#/, "")}`,
        onSubmit: (entry) => {
          const got = parse(entry);
          if (got === undefined) return LABEL_WORDS.shape;
          const done = updateLabel(f.app, f.user, repo, picked.id, got.name, got.hex);
          if (!done.ok) return done.error === "not_found" && admin() ? LABEL_WORDS.gone : refusal(done.error);
          reload();
          ctx.invalidate();
          return undefined;
        },
      }),
    );
  };
  const ask = (picked: Label): void => {
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Delete a label",
        body: [
          admin() && (counts.get(picked.id) ?? 0) > 0
            ? `Delete the label ${picked.name}? ${counts.get(picked.id)} open carry it.`
            : `Delete the label ${picked.name}? Issues carrying it lose it.`,
        ],
        actions: [{ label: "Keep", variant: "ghost" }, { label: "Delete", variant: "danger" }],
        onChoose: (i) => {
          if (i < 1) return;
          note = deleteLabel(f.app, f.user, repo, picked.id).ok ? DELETED_LINE : GONE_LINE;
          reload();
          state.clamp(labels?.length ?? 0);
          ctx.invalidate();
        },
      }),
    );
  };
  const screen: Screen = {
    title: "Labels",
    // Read each time: a demoted admin stops being offered `n`.
    get keys() {
      return [binding(["j", "k"], "move"), ...(admin() ? [binding(["n"], "new label"), binding(["e"], "edit label"), binding(["d"], "delete label")] : []), binding(["esc", "q"], "back")];
    },
    async load() {
      // Gated here as well as on the command: the screen is exported.
      hidden = !canRead(f.db, repo, f.user);
      if (hidden) labels = [];
      else reload();
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const right = area.x + area.w;
      const line = (y: number, text: string) => s.text(area.x + 1, area.y + y, text, style(c.fg, c.bg), right);
      if (hidden) return void line(0, NOT_FOUND_LINE);
      if (labels === undefined) return void line(0, "Reading…");
      if (labels.length === 0) {
        line(0, NO_LABELS_LINE);
        if (note !== "") line(area.h - 1, note);
        return;
      }
      const rows = note === "" ? area.h : Math.max(1, area.h - 1);
      if (note !== "") line(area.h - 1, note);
      const from = state.window(rows, labels.length);
      for (let i = 0; i < rows; i++) {
        const l = labels[from + i];
        if (l === undefined) break;
        const picked = from + i === state.index;
        s.text(area.x, area.y + i, picked ? ">" : " ", style(c.accent, c.bg), right);
        const x = labelChip(s, area.x + 1, area.y + i, c, { text: l.name, color: l.color }, right);
        s.text(x + 2, area.y + i, `#${l.color.replace(/^#/, "")}`, style(picked ? c.fg : c.muted, c.bg), right);
        if (admin()) s.text(x + 10, area.y + i, usage(l), style(c.muted, c.bg), right);
      }
    },
    key(e) {
      note = "";
      if (e.key === "j" || e.key === "down") state.move(1, labels?.length ?? 0);
      else if (e.key === "k" || e.key === "up") state.move(-1, labels?.length ?? 0);
      else if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "d" && !e.ctrl && !e.alt && !hidden && admin() && labels?.[state.index] !== undefined) {
        ask(labels[state.index]!);
      } else if (e.key === "e" && !e.ctrl && !e.alt && !hidden && admin() && labels?.[state.index] !== undefined) {
        rename(labels[state.index]!);
      } else if (e.key === "n" && !e.ctrl && !e.alt && !hidden && admin()) {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "New label",
            label: "name and six hex digits (bug d73a4a)",
            onSubmit: make,
          }),
        );
      } else return false;
      ctx.invalidate();
      return true;
    },
  };
  return screen;
}

/** The palette's door on a repository screen, for whoever may read it. */
export function labelsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !canRead(f.db, repo, f.user)) return [];
  return [
    {
      id: "labels",
      title: `${repo.ownerName}/${repo.name} — Labels`,
      hint: "its labels and their colours",
      run: () => ctx.push(labelsScreen(f, ctx, repo)),
    },
  ];
}
