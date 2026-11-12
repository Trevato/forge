/**
 * The fork tree in the terminal: the same reader the MCP `fork_tree` tool
 * calls (`actions/fork_tree.ts`), drawn as indented lines. It gates exactly as
 * the tool does: a repo the session's person may not read has no tree.
 */

import { forkTree, type ForkTree } from "../../actions/fork_tree.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { Scroll } from "./common.ts";

/**
 * The tree as text lines, `asked` marked with `*`, the viewer's own forks
 * with `(you)`; two spaces per generation.
 */
export function treeLines(tree: ForkTree | undefined, asked: string, width = 80, viewer?: string): string[] {
  if (tree === undefined) return ["Nothing to show."];
  const lines = tree.nodes.map((n) => {
    const follow = n.word === "" ? "" : `  ${n.word}`;
    const you = n.repo !== asked && viewer !== undefined && n.repo.startsWith(`${viewer}/`) ? "  (you)" : "";
    return truncate(`${"  ".repeat(n.depth)}${n.repo === asked ? "* " : ""}${n.repo}${you}${follow}`, width);
  });
  if (tree.truncated) lines.push("", "More forks exist than are shown.");
  return lines;
}

export function forkTreeScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: `Fork tree · ${repo.ownerName}/${repo.name}`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      lines = treeLines(forkTree(f.db, repo, f.user), `${repo.ownerName}/${repo.name}`, area.w - 4, f.user?.username);
      const from = scroll.window(area.h, lines.length);
      for (let i = 0; i < area.h; i++) {
        const line = lines[from + i];
        if (line !== undefined) s.text(area.x + 1, area.y + i, line, style(c.fg, c.bg), area.x + area.w);
      }
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return scroll.key(e, lines.length);
    },
  };
}
