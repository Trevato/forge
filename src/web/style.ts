/**
 * The design system, assembled. Four cascade layers in one served stylesheet:
 *
 *   reset       → the handful of UA defaults we disagree with
 *   base        → constants, type scale, focus, motion, the page shell
 *   components  → the component vocabulary (docs/DESIGN.md is its contract),
 *                 plus two surfaces with a vocabulary of their own: the
 *                 studio (`studio/style.ts`) and the board (`pages/board_style.ts`)
 *   content     → prose, code, diffs, and the furniture that frames them
 *   utilities   → the few one-liners pages are allowed to reach for
 *
 * Layers mean a 900-line sheet stays navigable and a utility can never be
 * accidentally out-specified by a component. No preprocessor, no framework —
 * the stylesheet is the artifact, served as written, and meant to be read.
 * Every color is a token from `design/themes.ts`, so all six themes get every
 * refinement for free.
 *
 * The studio's and the board's rules live beside the markup they style but
 * are served from here, at the end of `components`: they are static, so a
 * page has no business carrying them inline, and last in the layer is where
 * an inline block's rules used to win from. The import goes one way only:
 * this file reads those two, so neither may ever read `css` back.
 */

import { swatchCss, themeCss } from "../design/themes.ts";
import { boardCss } from "./pages/board_style.ts";
import { base, layers, reset, utilities } from "./style/base.ts";
import { components } from "./style/components.ts";
import { content } from "./style/content.ts";
import { pickCss } from "./pick.ts";
import { studioCss } from "./studio/style.ts";

export const css = [
  layers,
  themeCss,
  reset,
  base,
  components,
  studioCss,
  boardCss,
  content,
  utilities,
  swatchCss,
  pickCss,
].join("\n");
