/** Every post's time on the home timeline carries its exact UTC on hover (#6063). */
import { describe, expect, test } from "bun:test";
import type { Thought } from "../src/core/thoughts.ts";
import type { FeedItem } from "../src/feed/rank.ts";
import { feedCard, thoughtCard } from "../src/web/studio/feed.ts";

const at = "2026-03-04T05:06:07.000Z";
const stamp = /<time datetime="2026-03-04T05:06:07\.000Z"\s+title="2026-03-04 05:06 UTC"\s*>/;

describe("feed card times", () => {
  test("a post's time is a <time> with its exact UTC", () => {
    const item = { id: "e1", kind: "run", app: "alice/notes", actor: "scribe", at, what: "x", reason: "y", link: "/alice/notes/runs/r1" } as FeedItem;
    expect(feedCard(item).text).toMatch(stamp);
  });

  test("a thought's time is a <time> with its exact UTC", () => {
    const thought = { id: "t1", text: "hi", receivedAt: at } as Thought;
    expect(thoughtCard(thought, "alice", undefined).text).toMatch(stamp);
  });
});
