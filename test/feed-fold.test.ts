/** A pull's opened, reviewed and merged events are one post in the feed (#5808). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { promote } from "./helpers/members.ts";

describe("the feed folds a pull's events", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  const emit = (kind: string, payload: Record<string, unknown>) =>
    app.bus.append({ kind, repoId: repo.id, actorId: alice.id, payload });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fold-"));
    app = createApp({ dataDir, port: 0 });
    const r = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", allowReserved: true, email: "alice@f.dev",
      password: "a-good-passphrase", adminIfFirst: true });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    alice = r.value;
    const c = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!c.ok) throw new Error("repo");
    repo = c.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("30 folded pulls page through once each, and a failed run keeps its post", () => {
    for (let n = 1; n <= 30; n++) {
      emit("pull.opened", { number: n });
      emit("pull.reviewed", { number: n });
      emit("pull.reviewed", { number: n });
      emit("pull.merged", { number: n });
    }
    emit("run.finished", { kind: "ci", state: "failed", summary: "red", runId: "r1", number: 3 });
    const seen: string[] = [];
    let cursor: { score: number; id: string } | undefined;
    for (let page = 0; page < 20; page++) {
      const r = readFeed(app.db, alice, { limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...r.items.map((i) => i.link + "|" + i.what));
      if (r.next_cursor === null) break;
      const [score, id] = [Number(r.next_cursor.split("|")[0]), r.next_cursor.split("|").slice(1).join("|")];
      cursor = { score, id };
    }
    const pulls = seen.filter((s) => s.includes("pull request"));
    expect(pulls.length).toBe(30);
    expect(new Set(pulls.map((s) => s.split("|")[0])).size).toBe(30);
    expect(pulls.every((s) => s.includes("merged a pull request") && /opened .+, 2 reviews/.test(s))).toBe(true);
    expect(seen.filter((s) => s.includes("run failed")).length).toBe(1);
  });

  test("a pull with one event reads as before", () => {
    emit("pull.opened", { number: 99 });
    const item = readFeed(app.db, alice, { limit: 50 }).items.find((i) => i.link.endsWith("/pulls/99"));
    expect(item?.what).toBe("opened a pull request");
  });
});
