/**
 * The crew's model key in the terminal (#11154), the second door of
 * `POST /settings/crew/key`: what the crew runs on, and `a` to paste a key
 * (typed masked, never shown again), through the same `saveCrewKey` the page
 * uses. A forge admin who is a person only, as the page is.
 */

import { saveCrewKey } from "../../actions/crew_key.ts";
import { crewHasCredential } from "../../core/subscriptions.ts";
import { usdWords } from "../../spawn/credit.ts";
import { includedCredit } from "../../web/studio/crew_key.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind === "user";

/** What the crew runs on, in one line. */
export function crewKeyLine(f: Session): string {
  if (crewHasCredential(f.app.db)) return "The crew runs on your key. a adds another.";
  const credit = includedCredit(f.app);
  if (credit !== undefined && credit.leftUsd > 0)
    return `The crew is building on ${usdWords(credit.leftUsd)} of ${usdWords(credit.capUsd)} included credit. a adds your own key.`;
  if (credit !== undefined) return "The included credit is spent. a adds your own key to keep building.";
  return "The crew needs a model key to start. a adds yours.";
}

export function crewKeyScreen(f: Session, ctx: Ctx): Screen {
  let note = "";
  const screen: Screen = {
    title: "Crew key",
    keys: [binding(["a"], "add your key"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(area.x, area.y, truncate(note !== "" ? note : crewKeyLine(f), area.w), style(c.mutedFg, c.bg), area.x + area.w);
    },
    key(e) {
      if (e.ctrl || e.alt || e.key !== "a" || !isAdmin(f)) return false;
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Your model key",
          label: "API key or Claude token (never shown again)",
          mask: true,
          onSubmit: (token) =>
            saveCrewKey(f.app, f.user, token).then((saved) => {
              note = saved.ok ? "Key saved. The crew can work now." : saved.error === "not_found" ? "Only a forge admin adds a key." : "That key could not be saved. Check that it is the whole key.";
              ctx.invalidate();
            }),
        }),
      );
      return true;
    },
  };
  return screen;
}

/** The crew's key: what it runs on, and add yours. */
export const entry: PaletteEntry = {
  id: "crewkey",
  title: "Crew key",
  hint: "what the crew runs on; add your own model key",
  after: ["subscriptions"],
  offered: isAdmin,
  run: (session, ctx) => ctx.push(crewKeyScreen(session, ctx)),
};
