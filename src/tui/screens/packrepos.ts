/**
 * "Pack repositories" in the terminal (#10532): the list Settings › Packs
 * edits, through the same door (`packs/set.ts`), so a change shows on /packs
 * at once. Offered to site admins only; the action refuses anyone else.
 * Enter or e edits the list as one line, Esc or q closes.
 */

import { markedRepos, rejectedMarkedSentence } from "../../packs/marked.ts";
import { setPackRepos } from "../../packs/set.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const WIDTH = 72;
const INNER = WIDTH - 6;

export function packReposScreen(f: Session, ctx: Ctx): Screen {
  let note = "";
  const edit = (): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Pack repositories",
        label: "owner/name, separated by spaces",
        value: markedRepos(f.app.db).join(" "),
        hint: "Public repos with a pack.json at the root, like packs/games.",
        onSubmit: (text) => {
          const saved = setPackRepos(f.app, f.user, text);
          return saved.then((done) => {
            note = done.ok
              ? done.problems.length === 0
                ? "Saved. /packs shows them now."
                : `Saved; left out: ${done.problems.join("; ")}`
              : done.error === "forbidden"
                ? "Only an admin sets the pack repositories."
                : rejectedMarkedSentence(done.rejected);
            ctx.invalidate();
          });
        },
      }),
    );
  };
  const screen: Screen = {
    title: "Pack repositories",
    keys: [binding(["enter", "e"], "edit"), binding(["esc", "q"], "close")],
    render(area, s) {
      const marked = markedRepos(f.app.db);
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Pack repositories",
        body: [
          ...wrap(marked.length === 0 ? "None marked: /packs is empty." : marked.join("  "), INNER),
          ...(note === "" ? [] : ["", ...wrap(note, INNER)]),
        ],
        actions: [{ label: "Edit" }, { label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons[0] && ctx.hit(buttons[0], edit);
      buttons[1] && ctx.hit(buttons[1], () => ctx.pop());
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter" || e.key === "e") edit();
      return true;
    },
  };
  return screen;
}

/** The repos /packs lists: a site admin's, as Settings › Packs is. */
export const entry: PaletteEntry = {
  id: "pack-repos",
  title: "Pack repositories",
  hint: "which repositories /packs lists",
  after: ["mirror-packs", "packs"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(packReposScreen(session, ctx)),
};
