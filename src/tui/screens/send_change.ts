/**
 * "Send a change without a forge of your own" in the terminal: the same
 * steps `/llms.txt` and the MCP `spawn` answer print (`spawn/contribute_words.ts`),
 * as a scrolling card. Anyone may open it; it reads nothing and writes nothing.
 */

import { CONTRIBUTE_ONE_LINE, CONTRIBUTE_PATH } from "../../spawn/contribute_words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { Scroll } from "./common.ts";

/** The card's lines for a width. */
export function sendChangeLines(width = 80): string[] {
  const w = Math.max(20, width);
  return [...wrap(CONTRIBUTE_ONE_LINE, w), "", ...CONTRIBUTE_PATH.flatMap((step, i) => [...wrap(`${i + 1}. ${step}`, w), ""]).slice(0, -1)];
}

export function sendChangeScreen(ctx: Ctx): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: "Send a change",
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      lines = sendChangeLines(area.w - 4);
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

export const sendChangeCommand = (ctx: Ctx) => ({
  id: "send-change",
  title: "Send a change",
  hint: "fork, patch, pull: no forge of your own",
  run: () => ctx.push(sendChangeScreen(ctx)),
});
