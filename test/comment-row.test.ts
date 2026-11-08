import { expect, test } from "bun:test";
import { commentCard } from "../src/web/comments.ts";
import { threadComment } from "../src/web/pages/thread.ts";

const card = {
  id: "c1",
  author: "ada",
  at: "2026-01-01T00:00:00Z",
  body: "Hello **there**",
  verb: "commented",
};

test("a comment is a row, not a .card", () => {
  for (const out of [
    String(commentCard(card)),
    String(threadComment("c1", "ada", card.at, card.body)),
  ]) {
    expect(out).not.toMatch(/class="[^"]*\bcard\b/);
    expect(out).not.toContain("card-head");
    expect(out).toContain('class="comment-row"');
    expect(out).toContain('class="prose comment-body"');
    expect(out).toContain("<strong>there</strong>");
  }
});
