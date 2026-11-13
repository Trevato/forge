/**
 * Land it as it is, in the terminal (#11892): when the crew cannot go on, the
 * app's green pulls the viewer may land, from the same rows as the page
 * (`web/studio/land_as_is.ts`, a writer's, the check green). Enter lands the
 * pull under the cursor, squashed, as the page's button does, with the page's
 * refusals in its words. Offered in the palette only while there is one.
 */

import { mergePull } from "../../actions/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { mergeFailure } from "../../web/pages/pull.ts";
import { LAND_AS_IS, landable, stalledWords } from "../../web/studio/land_as_is.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

export function landScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let busy = false;
  return {
    title: `${repo.ownerName}/${repo.name} — ${LAND_AS_IS}`,
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], LAND_AS_IS)],
    render(area, s) {
      const c = ctx.theme.c;
      const all = landable(f.app, f.user, repo);
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(stalledWords(f.app) ?? "The crew can go on; nothing waits here.", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const lines: ListRow[] = all.map((p) => ({ title: p.title, meta: `#${p.number}` }));
      drawList(s, list!, c, state, lines);
    },
    key(e) {
      const all = landable(f.app, f.user, repo);
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || e.key !== "enter") return false;
      const at = all[state.index];
      if (at === undefined || busy) return true;
      busy = true;
      void mergePull(f.app, f.user, repo, at, "squash")
        .then((done) => ctx.toast(done.ok ? `Landed #${at.number} as it is.` : mergeFailure(done.error), done.ok ? undefined : "danger"))
        .finally(() => {
          busy = false;
          ctx.invalidate();
        });
      return true;
    },
  };
}

/** The palette's command while a repository with a pull to land as it is is open. */
export function landCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || landable(f.app, f.user, repo).length === 0) return [];
  return [
    {
      id: "land-as-is",
      title: `${repo.ownerName}/${repo.name} — ${LAND_AS_IS}`,
      hint: "the crew cannot go on: land a green pull as it is",
      run: () => ctx.push(landScreen(f, ctx, repo)),
    },
  ];
}
