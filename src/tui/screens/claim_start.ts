/**
 * Taking an agent's work, in the terminal (#10912): what the claim page does
 * for a person with the link the start call returned. `t` asks for the link,
 * the screen says whose repositories it holds, and they move only after a
 * confirm. It goes through `claimStart`, so the gate is the page's: a person's
 * account, a link that is open; an agent is never offered it.
 */
import { claimStart, CLAIM_WORDS, viewClaim } from "../../actions/claim.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { confirmScreen, promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The token of a claim link, whether the whole link or only its last part was typed. */
export const tokenOfLink = (typed: string): string => (typed.trim().split(/[?#]/)[0]!.split("/").filter((p) => p !== "").pop() ?? "").slice(0, 200);

export function claimStartScreen(f: Session, ctx: Ctx): Screen {
  let note = "Paste the claim link an agent gave you. t asks for it.";

  const offer = (typed: string): string | undefined | Promise<void> => {
    const token = tokenOfLink(typed);
    const seen = viewClaim(f.app, token);
    if (seen === undefined) return CLAIM_WORDS.not_found;
    if (seen.claimed) return CLAIM_WORDS.claimed;
    // The prompt closes itself when this returns; the confirm goes on after it.
    return Promise.resolve().then(() => ctx.push(
      confirmScreen(ctx, screen, {
        title: `Take ${seen.agent}'s work?`,
        body: [
          `${seen.repos.length} ${seen.repos.length === 1 ? "repository moves" : "repositories move"} to an organisation you own;`,
          "the agent stays in it as a member who can still push.",
          ...seen.repos.map((r) => `  ${r}`),
        ],
        actions: [{ label: "Take it" }, { label: "Cancel" }],
        onChoose: (i) => {
          if (i !== 0) return;
          void claimStart(f.app, f.user, token).then((done) => {
            note = done.ok
              ? `Taken: ${done.value.repos.join(", ")} now belong to ${done.value.org}.${done.value.stayed.length === 0 ? "" : ` Not moved: ${done.value.stayed.join(", ")}.`}`
              : CLAIM_WORDS[done.error];
            ctx.invalidate();
          });
        },
      }),
    ));
  };

  const screen: Screen = {
    title: "Take an agent's work",
    keys: [binding(["t"], "enter the link")],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(area.x, area.y, truncate(note, area.w), style(c.mutedFg, c.bg), area.x + area.w);
    },
    key(e) {
      if (e.ctrl || e.alt || e.key !== "t") return false;
      ctx.push(promptScreen(ctx, screen, { title: "Claim link", label: "the link the agent gave you", onSubmit: offer }));
      return true;
    },
  };
  return screen;
}

/** A person's, as the claim page is: the link is the proof, the account is theirs. */
export const entry: PaletteEntry = {
  id: "claim-start",
  title: "Take an agent's work",
  hint: "claim the repositories an agent started, from its one-time link",
  after: ["invites", "repos"],
  offered: (session) => session.user?.kind === "user",
  run: (session, ctx) => ctx.push(claimStartScreen(session, ctx)),
};
