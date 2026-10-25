/**
 * The releases view's sentences are said from src/release/words.ts alone
 * (#5613): the web page and the terminal screen import them, and a copy
 * typed back into either fails here.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { html } from "../src/web/html.ts";
import { liveSince, NO_RELEASES_YET, plain } from "../src/release/words.ts";

const FILES = ["src/web/pages/releases.ts", "src/tui/screens/releases.ts"];
// The live line's opening as a string, a template or markup would type it;
// a bare "live: " is also the `live: boolean` field of a release line.
const LITERALS = ['"live: ', "`live: ", ">live: ", "live: ${", "live: <", "since <time>", "A pull landed on the forge's own repository is recorded here.", "recorded here"];

test.each(FILES)("%s types none of the releases sentences", (file) => {
  const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
  for (const literal of LITERALS) expect(text).not.toContain(literal);
  expect(text).toContain('from "../../release/words.ts"');
});

test("the live line reads the same in both tags", () => {
  expect(liveSince(plain, "abc1234", "5m ago")).toBe("live: abc1234 since 5m ago");
  expect(liveSince(html, html`<span class="sha">${"abc1234"}</span>`, "<now>").toString()).toBe(
    'live: <span class="sha">abc1234</span> since &lt;now&gt;',
  );
  expect(NO_RELEASES_YET).toBe("A pull landed on the forge's own repository is recorded here.");
});
