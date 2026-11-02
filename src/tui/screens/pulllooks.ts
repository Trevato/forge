/**
 * `I` on a pull — its looks, newest first: the same read as MCP `pull` and
 * `GET …/pulls/:number/looks` (`pullLooks`), so a reader sees only what the
 * API would show them.
 */

import type { Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { pullLooks } from "../../looks/readable.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, ago, drawList, type ListRow } from "./common.ts";

const plain = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ");

export function pullLooksScreen(f: Session, ctx: Ctx, repo: Repo, pull: Pull): Screen {
  const state = new ListState();
  const looks = pullLooks(f.app, repo, pull, f.user);
  const rows: ListRow[] = looks.map((l) => ({
    title: plain(`${l.width} · ${l.says ?? "taken by the forge"}`),
    meta: ago(l.at),
    secondary: plain(`${l.by ?? "forge"} · ${l.commit.slice(0, 7)}`),
  }));
  return {
    title: `Looks · #${pull.number}`,
    get keys() {
      return [binding(["j", "k"], "move"), binding(["esc", "q"], "back")];
    },
    render(area, s) {
      if (rows.length === 0) {
        emptyState(s, area, ctx.theme.c, {
          title: "No looks yet",
          body: "A look lands once the preview is up, or when someone attaches one.",
        });
        return;
      }
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else state.key(e, rows.length);
      return true;
    },
  };
}
