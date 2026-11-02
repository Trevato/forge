import { clip } from "../text/clip.ts";

/** One line of a failure's summary on a narrow screen; the rest is in the run. */
const LINE_MAX = 80;

/** `text` cut to one line of at most `LINE_MAX` characters, with an ellipsis. */
export function oneLine(text: string): string {
  return clip(text, LINE_MAX);
}
