/**
 * A video plays inline, as wide as the pane and no wider, at its own aspect
 * ratio: `<video controls playsinline preload="metadata">`.
 */

import { player } from "./player.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export function video(input: RenderInput): Rendered {
  return player("video", input);
}
