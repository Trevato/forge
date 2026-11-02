/** The wall card on a pull offers one button to allow the new access or send it back (#7847). */
import { expect, test } from "bun:test";
import { wallCard } from "../src/web/studio/change.ts";

const wall = {
  loosened: [
    { resource: "pack", verb: "read", as: "anon", answer: "yes", from: "absent", to: "yes", floor: true },
  ],
} as const;

test("a writer is offered allow and send back, in plain words", () => {
  const html = String(wallCard(wall as never, "/a/b/pulls/3"));
  expect(html).toContain("anyone signed out could read pack records");
  expect(html).toContain('action="/a/b/pulls/3/merge"');
  expect(html).toContain('action="/a/b/pulls/3/review-state"');
  expect(html).toContain("changes_requested");
});

test("a reader is offered no button", () => {
  expect(String(wallCard(wall as never))).not.toContain("<form");
});
