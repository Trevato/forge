/**
 * "Get your own forge" in the terminal: the home page's `#yours` for anyone,
 * guests included. Every plan with its price (or "Paid" while
 * `FORGE_BILLING_PROVIDER` is not `stripe`), what it is, its buy link when
 * one is set, then where to get a hosted forge and how to run one yourself.
 * The words are `billing/plan_words.ts`, the same the web row prints; the
 * settings are read in one statement as the home reads them.
 */

import { billingProvider } from "../../billing/provider.ts";
import { GET_A_FORGE_PATH, planWords } from "../../billing/plan_words.ts";
import { UPSTREAM_REPO } from "../../core/upstream.ts";
import { getDoorSettings } from "../../settings/door.ts";
import { publicPlans } from "../../settings/plans.ts";
import type { App } from "../../app.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { Scroll } from "./common.ts";

/** The screen as text lines, read fresh on every draw. */
export function getForgeLines(app: App, width = 80, priced = billingProvider() === "stripe"): string[] {
  const w = Math.max(20, width);
  const { plans, links } = getDoorSettings(app.db);
  const origin = (app.config.url ?? "").replace(/\/$/, "");
  return [
    "Get your own forge",
    ...wrap("Hosted for you, or free and open source on a machine you keep.", w),
    "",
    "Plans",
    ...publicPlans(plans).flatMap((p) => {
      const words = planWords(p, priced, links);
      return [
        `  ${words.name}  ${words.price}`,
        ...wrap(words.is, w - 4).map((l) => `    ${l}`),
        ...(words.buy === undefined ? [] : [`    Pay: ${words.buy}`]),
      ];
    }),
    "",
    `Get a forge: ${origin}${GET_A_FORGE_PATH}`,
    "",
    "Or run it yourself, free and open source",
    `  git clone ${UPSTREAM_REPO}.git`,
    "  cd forge",
    "  bun install",
    "  bun run src/main.ts",
  ];
}

export function getForgeScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: "Get your own forge",
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      lines = getForgeLines(session.app, area.w - 4);
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

/** Offered to everyone, guests included, as the packs command is. */
export const getForgeCommand = (session: Session, ctx: Ctx) => ({
  id: "get-a-forge",
  title: "Get your own forge",
  hint: "the plans, where to get a hosted forge, how to run one yourself",
  run: () => ctx.push(getForgeScreen(session, ctx)),
});
