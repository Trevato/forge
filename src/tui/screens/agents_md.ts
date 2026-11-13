/**
 * How to work on this repository, in the terminal: the text `/<owner>/<name>/AGENTS.md`
 * answers (`view/agents_md.ts`), scrolled with j and k. Offered while a
 * repository the person may read is open.
 */

import { canRead, type Repo } from "../../core/repos.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { agentsMdOf } from "../../view/agents_md.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { Scroll, drawLines } from "./common.ts";

export function agentsMdScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const scroll = new Scroll();
  let text = "Reading…";
  let cache: { w: number; text: string; lines: ReturnType<typeof renderMarkdown> } | undefined;
  const origin = publicOrigin(f.app.config.url, `http://localhost:${f.app.config.port}`);
  void agentsMdOf(f.app.reposRoot, repo, origin).then((r) => {
    text = r.text;
    ctx.invalidate?.();
  });
  return {
    title: `${repo.ownerName}/${repo.name} — AGENTS.md`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const w = Math.max(20, area.w - 2);
      if (cache === undefined || cache.w !== w || cache.text !== text) cache = { w, text, lines: renderMarkdown(text, w, ctx.theme.c) };
      drawLines(s, area, ctx.theme.c, scroll, cache.lines);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else scroll.key(e, cache?.lines.length ?? 0);
      return true;
    },
  };
}

/** The palette's command while a readable repository is open. */
export function agentsMdCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !canRead(f.app.db, repo, f.user)) return [];
  return [
    {
      id: "agents-md",
      title: `${repo.ownerName}/${repo.name} — AGENTS.md`,
      hint: "how to work on this repository: install, tests, the contribute flow",
      run: () => ctx.push(agentsMdScreen(f, ctx, repo)),
    },
  ];
}
