/** A post about a pull or an issue that is over says how it ended; an open one says nothing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { settledOf } from "../src/feed/settled.ts";
import { feedCard } from "../src/web/studio/feed.ts";
import type { FeedItem } from "../src/feed/rank.ts";

let dir = "";
let app: App;
let alice: User;
let links: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-feed-settled-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const repo = made.value;
  for (const name of ["merged", "closed", "parked", "open"]) {
    const o = openIssue(app, alice, repo, { title: name });
    if (!o.ok) throw new Error(String(o.error));
    const id = (o.value as { id: string; number: number }).id;
    const number = (o.value as { number: number }).number;
    links[name] = `/alice/garden/${name === "merged" || name === "parked" ? "pulls" : "issues"}/${number}`;
    if (name === "merged" || name === "parked") {
      app.db.run("UPDATE issue SET kind = 'pull' WHERE id = ?", [id]);
      app.db.run(
        "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?, 'main', 'x', 'a', 'b', ?)",
        [id, name === "merged" ? "2026-10-25T00:00:00Z" : null],
      );
    }
    if (name !== "open")
      app.db.run("UPDATE issue SET state = 'closed', parked = ? WHERE id = ?", [name === "parked" ? 1 : 0, id]);
  }
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (id: string, kind: string, link: string) => ({ id, kind, link });

test("one post per state: merged, closed, parked, and none while open", () => {
  const got = settledOf(app.db, [
    post("a", "pull", links.merged!),
    post("b", "tell", links.closed!),
    post("c", "reply", links.parked!),
    post("d", "tell", links.open!),
    post("e", "run", links.merged!),
  ]);
  expect(got.get("a")).toBe("merged");
  expect(got.get("b")).toBe("closed");
  expect(got.get("c")).toBe("parked");
  expect(got.has("d")).toBe(false);
  expect(got.has("e")).toBe(false);
});

test("a page of 30 posts gets the right state for every post", () => {
  const states = [links.merged, links.closed, links.open];
  const want = ["merged", "closed", undefined] as const;
  const page = Array.from({ length: 30 }, (_, i) => post(`event:${i}`, "pull", states[i % 3]!));
  const got = settledOf(app.db, page);
  page.forEach((p, i) => expect(got.get(p.id)).toBe(want[i % 3] as never));
});

test("the card draws the badge beside the time, and none when open", () => {
  const item = (settled?: FeedItem["settled"]): FeedItem => ({
    id: "event:1", kind: "pull", app: "alice/garden", actor: "alice", at: "2026-10-25T00:00:00Z",
    link: "/alice/garden/pulls/1", what: "x", reason: "x", score: 1, ...(settled ? { settled } : {}),
  });
  expect(String(feedCard(item("merged")))).toContain('data-pr="merged"');
  expect(String(feedCard(item("merged")))).toContain("Merged</span");
  expect(String(feedCard(item("closed")))).toContain("Closed</span");
  expect(String(feedCard(item("parked")))).toContain("Parked</span");
  expect(String(feedCard(item()))).not.toMatch(/Merged<|Closed<|Parked</);
});
