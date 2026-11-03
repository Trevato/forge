/**
 * New commits upstream, in the terminal: the mirrors whose origin has moved
 * on, as the repository head shows them on the web ("N new commits upstream").
 * `t` takes them through `takeFromOrigin`, the page's own action, offered only
 * to a person who may write the repository. A reader sees the count; a guest
 * sees only what is public.
 */

import { requireWriter } from "../../actions/access.ts";
import { takeFromOrigin } from "../../actions/origins.ts";
import type { Repo } from "../../core/repos.ts";
import { aheadWords, CONFLICT_WORDS, mirrorsBehind, UNREAD_WORDS } from "../../origins/ahead.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The screen, and the take its last `t` started, for whoever must wait on it. */
export interface OriginAheadScreen extends Screen {
  taking(): Promise<void> | undefined;
}

export function originAheadScreen(f: Session, ctx: Ctx): OriginAheadScreen {
  const state = new ListState();
  let rows = mirrorsBehind(f.app, f.user);
  let taking: Promise<void> | undefined;
  const selected = () => rows[state.index];
  // Exactly the page's gate: the route behind Take them asks requireWriter.
  const mayTake = (repo: Repo | undefined): repo is Repo =>
    repo !== undefined && requireWriter(f.app, f.user, repo).ok;

  return {
    title: "New commits upstream",
    keys: [binding(["j", "k"], "move cursor"), binding(["t"], "take them")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      if (rows.length === 0) {
        emptyState(s, body!, c, { title: "Every mirror is level with its origin." });
        return;
      }
      const list: ListRow[] = rows.map((r) => ({
        title: `${r.repo.ownerName}/${r.repo.name}`,
        secondary: aheadWords(r.ahead),
        meta: "",
      }));
      const line = mayTake(selected()?.repo) ? "t takes them" : "you can read this, not take it";
      s.text(head!.x, head!.y, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, list);
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || e.key !== "t") return false;
      const repo = selected()?.repo;
      if (!mayTake(repo)) return false;
      taking = takeFromOrigin(f.app, f.user, repo).then((done) => {
        if (!done.ok) ctx.toast("that could not be taken", "danger");
        else if (done.value.kind === "conflict")
          ctx.toast(CONFLICT_WORDS(repo.defaultBranch, done.value.count), "danger");
        else if (done.value.kind === "unread") ctx.toast(UNREAD_WORDS, "danger");
        else ctx.toast("taken from the origin", "success");
        rows = mirrorsBehind(f.app, f.user);
        state.clamp(rows.length);
        ctx.invalidate();
      });
      return true;
    },
    taking: () => taking,
  };
}

/** Mirrors behind their origin, as the repository head has them. */
export const entry: PaletteEntry = {
  id: "origin-ahead",
  title: "New commits upstream",
  hint: "mirrors whose origin has moved on: take them",
  offered: () => true,
  run: (session, ctx) => ctx.push(originAheadScreen(session, ctx)),
};
