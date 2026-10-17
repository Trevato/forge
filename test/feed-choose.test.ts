/** A variant group is one `choose` item in the feed, and it stops asking once decided. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { muteRepo } from "../src/core/interactions.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { chooseCandidates } from "../src/feed/choose.ts";
import { promote } from "./helpers/members.ts";

describe("the feed's choose item", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-choose-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        allowReserved: true,
        email: `${username}@f.dev`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    await mk("root", true);
    alice = await mk("alice");
    bob = await mk("bob");
    const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!r.ok) throw new Error(`repo: ${JSON.stringify(r)}`);
    repo = r.value;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Sibling pulls in one group, written straight to the tables. */
  function group(name: string, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const issue = createIssue(app.db, {
        repoId: repo.id,
        authorId: alice.id,
        title: `${name} <b>${i}</b>`,
        kind: "pull",
      });
      if (!issue.ok) throw new Error(issue.error);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, variant_group)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
        )
        .run(issue.value.id, `${name}-${i}`, name);
      ids.push(issue.value.id);
    }
    return ids;
  }
  const chooses = (viewer: User, name: string) =>
    readFeed(app.db, viewer, { now: Date.now() }).items.filter(
      (i) => i.id === `choose:${name}`,
    );

  test("two sibling pulls are one choose item that asks and links to the deck", () => {
    group("pair", 2);
    const items = chooses(alice, "pair");
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("choose");
    expect(items[0]!.what).toBe("choose among 2 open variants of “pair <b>0</b>”");
    expect(items[0]!.link).toBe("/alice/garden/variants/pair");
    expect(items[0]!.what).toContain("<b>0</b>");
    // Nothing else in the feed repeats the group per pull.
    expect(readFeed(app.db, alice).items.filter((i) => i.kind === "choose")).toHaveLength(1);
  });

  test("one who cannot write the repository is not asked", () => {
    expect(chooses(bob, "pair")).toHaveLength(0);
  });

  test("a shipped sibling decides the group: the item is gone", () => {
    const ids = group("shipped", 3);
    expect(chooses(alice, "shipped")).toHaveLength(1);
    app.db.query("UPDATE pull SET merged_at = '2026-10-01T00:00:00Z' WHERE issue_id = ?1").run(ids[0]!);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id IN (?1, ?2)").run(ids[1]!, ids[2]!);
    expect(chooses(alice, "shipped")).toHaveLength(0);
  });

  test("a group whose siblings all closed asks nothing", () => {
    const ids = group("closed", 2);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id IN (?1, ?2)").run(ids[0]!, ids[1]!);
    expect(chooses(alice, "closed")).toHaveLength(0);
  });

  test("a group down to one open sibling has nothing left to choose", () => {
    const ids = group("last", 2);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(ids[0]!);
    expect(chooses(alice, "last")).toHaveLength(0);
  });

  test("muting the app does not mute an open choice", () => {
    muteRepo(app.db, alice.id, repo.id);
    expect(chooses(alice, "pair")).toHaveLength(1);
  });

  test("the choose item reaches the API feed", async () => {
    const token = createToken(app.db, alice.id, "t", "rw").token;
    const res = await fetch(`${servers.url}/api/v1/feed`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { items: { id: string; kind: string; what: string }[] };
    const item = body.items.find((i) => i.id === "choose:pair");
    expect(item?.kind).toBe("choose");
    expect(item?.what).toBe("choose among 2 open variants of “pair <b>0</b>”");
  });

  test("the item's query count does not grow with the siblings", () => {
    const count = (): number => {
      let n = 0;
      const spy = new Proxy(app.db, {
        get(t, k) {
          const v: unknown = Reflect.get(t, k, t);
          if (k === "query")
            return (...a: Parameters<Database["query"]>) => (n++, t.query(...a));
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as Database;
      expect(chooseCandidates(spy, [repo]).length).toBeGreaterThan(0);
      return n;
    };
    const before = count();
    group("wide", 12);
    expect(count()).toBe(before);
  });
});
