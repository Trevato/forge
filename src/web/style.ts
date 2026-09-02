/**
 * The design system, assembled. Four cascade layers in one served stylesheet:
 *
 *   reset       → the handful of UA defaults we disagree with
 *   base        → constants, type scale, focus, motion, the page shell
 *   components  → the component vocabulary (docs/DESIGN.md is its contract)
 *   content     → prose, code, diffs, and the furniture that frames them
 *   utilities   → the few one-liners pages are allowed to reach for
 *
 * Layers mean a 900-line sheet stays navigable and a utility can never be
 * accidentally out-specified by a component. No preprocessor, no framework —
 * the stylesheet is the artifact, served as written, and meant to be read.
 * Every color is a token from `design/themes.ts`, so all six themes get every
 * refinement for free.
 */

import { swatchCss, themeCss } from "../design/themes.ts";
import { base, layers, reset, utilities } from "./style/base.ts";
import { components } from "./style/components.ts";
import { content } from "./style/content.ts";

/**
 * Twelve avatar hues as static rules. A name hashes to one of these buckets
 * (`ui.ts`, `avatar`), so identity color needs no per-page CSS and no inline
 * style attribute the CSP would refuse.
 */
const avatarHues = `@layer components {\n${Array.from(
  { length: 12 },
  (_, i) => `.avatar[data-h="${i}"] { --hue: ${i * 30 + 8}; }`,
).join("\n")}\n}`;

export const css = [
  layers,
  themeCss,
  reset,
  base,
  components,
  avatarHues,
  content,
  utilities,
  swatchCss,
].join("\n");
