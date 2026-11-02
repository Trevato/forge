/**
 * The Labels command, a repository's (#7841): each label the repository
 * defines, as the issue screen draws it — the colour chip, then its hex —
 * read with `listLabels`, name order. Read-only, no counts. Offered to, and
 * read for, only someone who may read the repository.
 */

import { LABEL_WORDS } from "../../actions/label_words.ts";
import { requireRepoAdmin } from "../../actions/access.ts";
import { createLabel } from "../../actions/repos.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { listLabels, type Label } from "../../core/issues.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { ListState, promptScreen } from "./common.ts";
import { labelChip } from "../ui/widgets.ts";
import type { Session } from "../session.ts";

/** What a viewer who may not read the repository sees: what the page's 404 says. */
export const NOT_FOUND_LINE = "No such repository";
export const NOT_ALLOWED_LINE = "Only a repository admin can make a label.";
export const NO_LABELS_LINE = "No labels yet.";

export function labelsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let labels: Label[] | undefined;
  let hidden = false;
  const state = new ListState();
  // Only whoever `requireRepoAdmin` admits is offered `n`.
  const admin = (): boolean => requireRepoAdmin(f.app, f.user, repo).ok;

  /** "name hex": the last word is the colour; a leading `#` is allowed. */
  const make = (entry: string): string | undefined => {
    const words = entry.trim().split(/\s+/);
    const hex = (words.pop() ?? "").replace(/^#/, "");
    const name = words.join(" ");
    if (name === "" || !/^[0-9a-fA-F]{6}$/.test(hex)) return LABEL_WORDS.shape;
    const made = createLabel(f.app, f.user, repo, name, hex.toLowerCase());
    if (!made.ok) return made.error === "taken" ? LABEL_WORDS.taken : made.error === "invalid" ? LABEL_WORDS.shape : NOT_ALLOWED_LINE;
    labels = listLabels(f.db, repo.id);
    ctx.invalidate();
    return undefined;
  };
  const screen: Screen = {
    title: "Labels",
    // Read each time: a demoted admin stops being offered `n`.
    get keys() {
      return [binding(["j", "k"], "move"), ...(admin() ? [binding(["n"], "new label")] : []), binding(["esc", "q"], "back")];
    },
    async load() {
      // Gated here as well as on the command: the screen is exported.
      hidden = !canRead(f.db, repo, f.user);
      labels = hidden ? [] : listLabels(f.db, repo.id);
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const right = area.x + area.w;
      const line = (y: number, text: string) => s.text(area.x + 1, area.y + y, text, style(c.fg, c.bg), right);
      if (hidden) return void line(0, NOT_FOUND_LINE);
      if (labels === undefined) return void line(0, "Reading…");
      if (labels.length === 0) return void line(0, NO_LABELS_LINE);
      const from = state.window(area.h, labels.length);
      for (let i = 0; i < area.h; i++) {
        const l = labels[from + i];
        if (l === undefined) break;
        const picked = from + i === state.index;
        s.text(area.x, area.y + i, picked ? ">" : " ", style(c.accent, c.bg), right);
        const x = labelChip(s, area.x + 1, area.y + i, c, { text: l.name, color: l.color }, right);
        s.text(x + 2, area.y + i, `#${l.color.replace(/^#/, "")}`, style(picked ? c.fg : c.muted, c.bg), right);
      }
    },
    key(e) {
      if (e.key === "j" || e.key === "down") state.move(1, labels?.length ?? 0);
      else if (e.key === "k" || e.key === "up") state.move(-1, labels?.length ?? 0);
      else if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "n" && !e.ctrl && !e.alt && !hidden && admin()) {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "New label",
            label: "name and six hex digits (bug d73a4a)",
            onSubmit: make,
          }),
        );
      }
      else return false;
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
