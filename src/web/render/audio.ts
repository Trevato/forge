/** An audio file plays inline: `<audio controls preload="metadata">`. */

import { player } from "./player.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export function audio(input: RenderInput): Rendered {
  return player("audio", input);
}
