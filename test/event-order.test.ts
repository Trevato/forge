/**
 * Events keep their order across processes (#932). During a roll two
 * processes write to one database (#875); each makes ids in order only
 * among its own, so an event the other writes in the same millisecond can
 * carry the smaller id. Every replay resumes by the event table's own
 * sequence, not by the id, so a stream resumed after one misses nothing.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents, listEventsVisibleTo } from "../src/core/events.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("events keep their order across processes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let other: Database;
  let alice: User;
  let repoId = "";
  let cookie = "";
  /** The first event, written by this process. */
  let first = "";
  /** The second, written later by the other process, with a smaller id. */
  let second = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-event-order-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@f.dev",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const repo = await createRepo(app, alice, { name: "lab", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    repoId = repo.value.id;
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    first = app.bus.append({
      kind: "issue.opened",
      repoId,
      actorId: alice.id,
      payload: { number: 1 },
    }).id;
    // The other process, in the same millisecond: same time prefix, the
    // smallest random part, written after.
    second = `${first.slice(0, 10)}${"0".repeat(16)}`;
    expect(second < first).toBe(true);
    other = new Database(join(dataDir, "forge.db"));
    other
      .query(
        "INSERT INTO event (id, kind, repo_id, actor_id, payload) VALUES (?1, 'issue.opened', ?2, ?3, '{\"number\":2}')",
      )
      .run(second, repoId, alice.id);
  });
  afterAll(async () => {
    other.close();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the lists put the later event first, whatever its id", () => {
    expect(listEvents(app.db, { repoId, kind: "issue.opened", limit: 2 }).map((e) => e.id)).toEqual([
      second,
      first,
    ]);
    expect(
      listEventsVisibleTo(app.db, alice, { limit: 2 }).map((e) => e.id),
      // The two newest anywhere are these two.
    ).toEqual([second, first]);
  });

  test("a list resumed after the first event still has the second", () => {
    expect(listEvents(app.db, { repoId, kind: "issue.opened", afterId: first }).map((e) => e.id)).toEqual([
      second,
    ]);
    expect(
      listEventsVisibleTo(app.db, alice, { afterId: first }).map((e) => e.id),
      // Only what came after the first.
    ).toEqual([second]);
  });

  const replayed = async (path: string, lastEventId: string): Promise<string> => {
    const res = await fetch(`${servers.url}${path}`, {
      headers: { cookie, "last-event-id": lastEventId },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 2_000;
    while (!text.includes(`id: ${second}`) && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(200).then(() => undefined),
      ]);
      if (next === undefined || next.done) continue;
      text += new TextDecoder().decode(next.value);
    }
    if (!text.includes(`id: ${second}`)) throw new Error(`never came: still waiting while !text.includes(\`id: \${second}\`)`);
    await reader.cancel();
    return text;
  };

  test("the forge-wide stream resumed after the first event replays the second", async () => {
    expect(await replayed("/events", first)).toContain(`id: ${second}`);
  });

  test("the repository's stream resumes the same way", async () => {
    expect(await replayed("/alice/lab/stream", first)).toContain(`id: ${second}`);
  });

  test("a resume from an id nobody holds falls back to comparing ids", () => {
    const past = "0".repeat(26);
    const future = "z".repeat(26);
    expect(
      listEvents(app.db, { repoId, kind: "issue.opened", afterId: past }).map((e) => e.id).sort(),
    ).toEqual([first, second].sort());
    expect(listEvents(app.db, { repoId, kind: "issue.opened", afterId: future })).toEqual([]);
  });

  const seqOf = (id: string): number =>
    (app.db.query("SELECT seq FROM event WHERE id = ?1").get(id) as { seq: number }).seq;

  test("every insert takes the next place, raw SQL from another connection included", () => {
    expect(seqOf(second)).toBe(seqOf(first) + 1);
  });

  test("the order is the event's own number, not where SQLite keeps the row", () => {
    // A later event that lands in a reused, smaller rowid (as a copy that
    // renumbers rows can leave it) still comes after the ones before it.
    const third = `${first.slice(0, 10)}${"0".repeat(15)}1`;
    const freed = (
      app.db.query("SELECT MIN(rowid) AS r FROM event").get() as { r: number }
    ).r;
    app.db.query("DELETE FROM event WHERE rowid = ?1").run(freed);
    other
      .query(
        "INSERT INTO event (rowid, id, kind, repo_id, actor_id, payload) VALUES (?1, ?2, 'issue.opened', ?3, ?4, '{\"number\":3}')",
      )
      .run(freed, third, repoId, alice.id);
    expect(
      listEvents(app.db, { repoId, kind: "issue.opened", limit: 3 }).map((e) => e.id),
    ).toEqual([third, second, first]);
    expect(
      listEvents(app.db, { repoId, kind: "issue.opened", afterId: second }).map((e) => e.id),
    ).toEqual([third]);
  });

  test("VACUUM leaves every event's place as it was", () => {
    const before = app.db
      .query("SELECT id, seq FROM event ORDER BY seq")
      .all() as { id: string; seq: number }[];
    app.db.run("VACUUM");
    expect(app.db.query("SELECT id, seq FROM event ORDER BY seq").all()).toEqual(before);
  });
});
