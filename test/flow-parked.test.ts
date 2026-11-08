/** The parked count (#6471): by the park note's time, only while it is the newest word on an open issue. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { parkedSays, readParked } from "../src/flow/parked.ts";

const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

async function world() {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-parked-")), port: 0 });
  const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const alice = made.value;
  const repo = async (name: string, visibility: "public" | "private") => {
    const r = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name, visibility, description: name });
    if (!r.ok) throw new Error(r.error);
    // The person who set the crew going speaks for it (`BY_CREW`).
    app.db.query("UPDATE repo SET autonomy_by = ?1 WHERE id = ?2").run(alice.id, r.value.id);
    return r.value;
  };
  let n = 0;
  const issue = (repoId: string, title: string, state = "open") => {
    const issueId = id();
    n++;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, ?6)`)
      .run(issueId, repoId, n, title, alice.id, state);
    return issueId;
  };
  const say = (issueId: string, body: string, at: string) =>
    app.db.query(`INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).run(id(), issueId, alice.id, body, at);
  const mallory = async () => {
    const m = await createUser(app.db, { username: "mallory", email: "mallory@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!m.ok) throw new Error(m.error);
    return m.value;
  };
  const park = (issueId: string, at: string) => say(issueId, "Parked by the crew: could not finish.", at);
  return { app, alice, repo, issue, say, park, mallory };
}

describe("flow parked", () => {
  test("counts by the park note's time; closed and spoken-after issues are left out", async () => {
    const w = await world();
    const r = await w.repo("p", "public");
    expect(readParked(w.app.db, NOW)).toEqual({ day: 0, week: 0, newest: [] });
    w.park(w.issue(r.id, "today"), ago(2));
    w.park(w.issue(r.id, "three days"), ago(72));
    w.park(w.issue(r.id, "ten days"), ago(240));
    w.park(w.issue(r.id, "closed", "closed"), ago(1));
    const spoken = w.issue(r.id, "spoken after");
    w.park(spoken, ago(5));
    w.say(spoken, "Try it smaller.", ago(3));
    const got = readParked(w.app.db, NOW);
    expect(got.day).toBe(1);
    expect(got.week).toBe(2);
    expect(got.newest.map((x) => x.title)).toEqual(["today", "three days"]);
    expect(got.newest[0]).toEqual({ repo: "alice/p", issue: 1, title: "today" });
  });

  test("a park after a person's word counts; newest holds at most three", async () => {
    const w = await world();
    const r = await w.repo("p", "public");
    const again = w.issue(r.id, "again");
    w.park(again, ago(30));
    w.say(again, "Try this.", ago(20));
    w.park(again, ago(10));
    for (const h of [1, 2, 3, 4]) w.park(w.issue(r.id, `i${h}`), ago(h));
    const got = readParked(w.app.db, NOW);
    expect(got.week).toBe(5);
    expect(got.newest.map((x) => x.title)).toEqual(["i1", "i2", "i3"]);
  });

  test("publicOnly hides a private repository's issue", async () => {
    const w = await world();
    const pub = await w.repo("pub", "public");
    const priv = await w.repo("priv", "private");
    w.park(w.issue(pub.id, "open one"), ago(4));
    w.park(w.issue(priv.id, "secret"), ago(1));
    expect(readParked(w.app.db, NOW).week).toBe(2);
    const only = readParked(w.app.db, NOW, true);
    expect(only.week).toBe(1);
    expect(only.newest.map((x) => x.title)).toEqual(["open one"]);
  });

  test("a non-crew commenter's park note is not a park", async () => {
    const w = await world();
    const r = await w.repo("p", "public");
    const m = await w.mallory();
    const issueId = w.issue(r.id, "faked");
    w.app.db
      .query(`INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .run(id(), issueId, m.id, "Parked by the crew: not really.", ago(1));
    expect(readParked(w.app.db, NOW)).toEqual({ day: 0, week: 0, newest: [] });
  });

  test("the Flow dialog and the MCP flow reading say the same line", async () => {
    const w = await world();
    const r = await w.repo("p", "public");
    expect(flowLines(w.app.db, NOW, []).join(" ")).toContain("Nothing parked by the crew");
    w.park(w.issue(r.id, "stuck"), ago(2));
    const says = parkedSays(readParked(w.app.db, NOW));
    expect(says).toBe("1 parked in 24 h, 1 in 7 d; newest alice/p#1 stuck");
    expect(flowLines(w.app.db, NOW, []).join(" ")).toContain("1 parked in 24 h, 1 in 7 d;");
    const f = flowFor(w.app, { kind: "owner" }, NOW);
    expect(f.parked).toMatchObject({ says, day: 1, week: 1 });
  });

  test("a sealed parked issue on a public repository is the owner's, not an agent's", async () => {
    const w = await world();
    const r = await w.repo("p", "public");
    const sealed = w.issue(r.id, "security report");
    w.app.db.query("UPDATE issue SET sealed = 1 WHERE id = ?1").run(sealed);
    w.park(sealed, ago(1));
    expect(readParked(w.app.db, NOW).week).toBe(1);
    expect(readParked(w.app.db, NOW, true)).toEqual({ day: 0, week: 0, newest: [] });
  });
});
