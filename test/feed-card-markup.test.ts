/** The home feed's cards are drawn from §5's parts: no `.fcard-*` class is left in the markup (#4267). */
import { describe, expect, test } from "bun:test";
import type { Placement } from "../src/core/placements.ts";
import type { Thought } from "../src/core/thoughts.ts";
import type { FeedItem } from "../src/feed/rank.ts";
import { feedCard, thoughtCard } from "../src/web/studio/feed.ts";

const item = (over: Partial<FeedItem> = {}): FeedItem =>
  ({
    id: "e1",
    kind: "run",
    app: "alice/notes",
    actor: "scribe",
    at: new Date().toISOString(),
    what: "Sorted <b>the</b> list",
    reason: "because the crew said so",
    link: "/alice/notes/runs/r1",
    ...over,
  }) as FeedItem;

describe("feed card markup", () => {
  test("a post keeps its words, link and forms and none of the old names", () => {
    const out = feedCard(item()).text;
    expect(out).not.toMatch(/fcard-/);
    expect(out).toContain("scribe");
    expect(out).toContain("because the crew said so");
    expect(out).toContain('href="/alice/notes/runs/r1"');
    expect(out).toContain("Sorted &lt;b&gt;the&lt;/b&gt; list");
    expect(out).toContain('action="/alice/notes/runs/r1/steer"');
    expect(out).toContain('name="text"');
    expect(out).toContain('maxlength="2000"');
    expect(out).toContain("Dismiss");
    expect(out).toContain('class="small muted break"');
  });

  test("a long actor and app name carry break", () => {
    const long = "a".repeat(120);
    const out = feedCard(item({ actor: long, app: `alice/${long}` })).text;
    expect(out).toContain(`<strong class="break">${long}</strong`);
    expect(out).toContain(`<span class="muted small break">alice/${long} · `);
  });

  test("a tell form posts to the app's own tell", () => {
    const out = feedCard(item({ kind: "pull", link: "/alice/notes/pulls/1" })).text;
    expect(out).toContain('action="/alice/notes/tell"');
    expect(out).not.toMatch(/fcard-/);
  });

  test("a thought keeps its line breaks and its reply wraps", () => {
    const thought = { id: "t1", text: "one\ntwo <i>", receivedAt: new Date().toISOString() } as Thought;
    const placement = { kind: "placed", reply: "Made #7", placed: [{ number: 7, repo: "alice/notes" }] } as unknown as Placement;
    const out = thoughtCard(thought, "alice", placement).text;
    expect(out).not.toMatch(/fcard-/);
    expect(out).toContain("one<br />two &lt;i&gt;");
    expect(out).toContain('href="/alice/notes/issues/7"');
    expect(out).toContain('data-placement="placed"');
    expect(out).toContain("break");
  });
});
