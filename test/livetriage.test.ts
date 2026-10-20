/**
 * Live triage closes an issue the crew noted already done on main, when
 * every commit it names is on the base; nothing else, and nothing twice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue, setIssueState } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { ALREADY_NOTE } from "../src/crew/already.ts";
import { liveTriage, MOST_CHANGES } from "../src/crew/livetriage.ts";

describe("live triage", () => {
  let dir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let oid: string;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const issue = (title: string): Issue => {
    const opened = openIssue(app, alice, fresh(), { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const note = (on: Issue, ...oids: string[]) =>
    addComment(app, alice, fresh(), on, `${ALREADY_NOTE}${oids.join(" ")}`);
  const closedEvents = () =>
    app.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM event WHERE kind = 'issue.closed'`).get()!.n;
  const state = (on: Issue) => getIssueById(app.db, on.id)!;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-livetriage-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep it small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const seeded = await commitToBranch(app, alice, fresh(), {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    oid = seeded.value.commitOid;
  });
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("closes a noted issue on base, leaves one off base, and a second pass changes nothing", async () => {
    const done = issue("Already built");
    const off = issue("Not on base");
    const plain = issue("Nothing noted");
    note(done, oid);
    note(off, oid, "a".repeat(40));
    const before = closedEvents();

    const first = await liveTriage(app, fresh());
    expect(first).toEqual({ closed: 1 });
    expect(state(done).state).toBe("closed");
    expect(state(done).closeReason).toBe("done");
    expect(listComments(app.db, done.id).some((c) => c.body.includes(oid.slice(0, 7)))).toBe(true);
    expect(listComments(app.db, done.id).some((c) => c.body.includes("live triage"))).toBe(true);
    expect(state(off).state).toBe("open");
    expect(state(plain).state).toBe("open");
    expect(closedEvents()).toBe(before + 1);

    const second = await liveTriage(app, fresh());
    expect(second.closed).toBe(0);
    expect(closedEvents()).toBe(before + 1);
  });

  test("a person's reopen stands: the next tick does not close it again", async () => {
    const back = issue("Reopened");
    note(back, oid);
    expect((await liveTriage(app, fresh())).closed).toBe(1);
    const reopened = setIssueState(app, alice, fresh(), state(back), "open");
    expect(reopened.ok).toBe(true);
    const before = closedEvents();
    expect((await liveTriage(app, fresh())).closed).toBe(0);
    expect(state(back).state).toBe("open");
    expect(closedEvents()).toBe(before);
  });

  test("a note a person wrote closes nothing", async () => {
    const bob = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    const mine = issue("Person's note");
    app.db
      .query(`INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .run("c-bob", mine.id, bob.value.id, `${ALREADY_NOTE}${oid}`, new Date().toISOString());
    expect((await liveTriage(app, fresh())).closed).toBe(0);
    expect(state(mine).state).toBe("open");
  });

  test("a close that rolls back is neither counted nor announced", async () => {
    const stuck = issue("Rolls back");
    note(stuck, oid);
    const before = closedEvents();
    app.db.run(
      `CREATE TRIGGER no_close_note BEFORE INSERT ON comment
         WHEN NEW.body LIKE 'Closed: already done%'
         BEGIN SELECT RAISE(ABORT, 'rolled back'); END`,
    );
    try {
      const did = await liveTriage(app, fresh());
      expect(did.closed).toBe(0);
      expect(state(stuck).state).toBe("open");
      expect(closedEvents()).toBe(before);
    } finally {
      app.db.run(`DROP TRIGGER no_close_note`);
    }
    expect((await liveTriage(app, fresh())).closed).toBe(1);
    expect(state(stuck).state).toBe("closed");
  });

  test("at most 25 changes per repository per tick", async () => {
    const many = Array.from({ length: MOST_CHANGES + 3 }, (_, n) => issue(`Many ${n}`));
    for (const m of many) note(m, oid);
    expect((await liveTriage(app, fresh())).closed).toBe(MOST_CHANGES);
    expect((await liveTriage(app, fresh())).closed).toBe(3);
  });
});
