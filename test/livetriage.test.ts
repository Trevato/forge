/**
 * Live triage closes an issue the crew noted already done on main, when
 * every commit it names is on the base; nothing else, and nothing twice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue, setIssueState } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { addDependency, blockerNumbersFor } from "../src/core/dependencies.ts";
import { getIssueById, labelsFor, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { ALREADY_NOTE } from "../src/crew/already.ts";
import { ensureDirectionIssue } from "../src/crew/autonomy.ts";
import { FILE_AFTER_MS, FOLDED_NOTE, liveTriage, MOST_CHANGES, tickFields } from "../src/crew/livetriage.ts";

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
    expect(first.closed).toBe(1);
    expect(first.folded).toBe(0);
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

  describe("duplicate titles", () => {
    let bot: User;
    beforeAll(async () => {
      const made = await createAgent(app, alice, { username: "dupbot" });
      if (!made.ok) throw new Error(String(made.error));
      bot = made.value.user;
      expect(addToCrew(app, alice, fresh(), "dupbot").ok).toBe(true);
    });
    const by = (who: User, title: string): Issue => {
      const opened = openIssue(app, who, fresh(), { title });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    };

    test("the newer closes into the older, dependents follow, case and punctuation ignored", async () => {
      const older = by(alice, "Dup: Add the Thing!");
      const newer = by(alice, "dup add   the thing");
      const waiter = issue("Waits on the newer");
      addDependency(app.db, waiter, newer, alice.id);
      const did = await liveTriage(app, fresh());
      expect(did.closed).toBe(1);
      expect(state(older).state).toBe("open");
      expect(state(newer).state).toBe("closed");
      expect(listComments(app.db, newer.id).some((c) => c.body === `duplicate of #${older.number}`)).toBe(true);
      expect(blockerNumbersFor(app.db, [waiter.id]).get(waiter.id)).toEqual([older.number]);
      expect((await liveTriage(app, fresh())).closed).toBe(0);
    });

    test("a person's newer issue is never closed into a crew member's: the older closes", async () => {
      const older = by(bot, "Crew wrote this first");
      const newer = by(alice, "crew wrote this FIRST");
      expect((await liveTriage(app, fresh())).closed).toBe(1);
      expect(state(older).state).toBe("closed");
      expect(state(newer).state).toBe("open");
      expect(listComments(app.db, older.id).some((c) => c.body === `duplicate of #${newer.number}`)).toBe(true);
    });

    test("a crew member's newer issue closes into a person's older one", async () => {
      const older = by(alice, "Person wrote this first");
      const newer = by(bot, "Person wrote this first");
      expect((await liveTriage(app, fresh())).closed).toBe(1);
      expect(state(older).state).toBe("open");
      expect(state(newer).state).toBe("closed");
      expect(listComments(app.db, newer.id).some((c) => c.body === `duplicate of #${older.number}`)).toBe(true);
    });

    test("the folded issue's own blockers move to the survivor", async () => {
      const older = by(alice, "Blockers move");
      const newer = by(alice, "blockers MOVE");
      const gate = issue("Blocks the newer");
      addDependency(app.db, newer, gate, alice.id);
      expect((await liveTriage(app, fresh())).closed).toBe(1);
      expect(blockerNumbersFor(app.db, [older.id]).get(older.id)).toEqual([gate.number]);
    });

    test("a near-miss title stays open", async () => {
      const a = by(alice, "Make the parser faster");
      const b = by(alice, "Make the parsers faster");
      expect((await liveTriage(app, fresh())).closed).toBe(0);
      expect(state(a).state).toBe("open");
      expect(state(b).state).toBe("open");
    });

    test("a person's reopen of a folded issue stands, in both orders", async () => {
      const older = by(alice, "Reopen me please");
      const newer = by(alice, "reopen me please");
      expect((await liveTriage(app, fresh())).closed).toBe(1);
      expect(setIssueState(app, alice, fresh(), state(newer), "open").ok).toBe(true);
      expect((await liveTriage(app, fresh())).closed).toBe(0);
      expect(state(newer).state).toBe("open");
      expect(state(older).state).toBe("open");

      const crewOlder = by(bot, "Reopen the crew one");
      const personNewer = by(alice, "Reopen the crew one");
      expect((await liveTriage(app, fresh())).closed).toBe(1);
      expect(state(crewOlder).state).toBe("closed");
      expect(setIssueState(app, alice, fresh(), state(crewOlder), "open").ok).toBe(true);
      expect((await liveTriage(app, fresh())).closed).toBe(0);
      expect(state(crewOlder).state).toBe("open");
      expect(state(personNewer).state).toBe("open");
    });

    test("a person's comment that starts like the note does not protect a duplicate", async () => {
      by(alice, "Typed note title");
      const newer = by(alice, "Typed note title");
      addComment(app, alice, fresh(), newer, "duplicate of #1 is what I thought, but no");
      expect((await liveTriage(app, fresh())).closed).toBe(1);
      expect(state(newer).state).toBe("closed");
    });

    test("a link that would close a loop is kept, not dropped", async () => {
      const older = by(alice, "Loop survivor");
      const newer = by(alice, "loop survivor");
      const mid = issue("Loop middle");
      addDependency(app.db, mid, newer, alice.id);
      addDependency(app.db, older, mid, alice.id);
      expect((await liveTriage(app, fresh())).closed).toBe(1);
      expect(state(newer).state).toBe("closed");
      expect(blockerNumbersFor(app.db, [mid.id]).get(mid.id)).toEqual([newer.number]);
    });

    test("the plan's own issues are neither folded nor chosen as survivor", async () => {
      const umbrella = by(alice, "Later: park these");
      const twin = by(alice, "later: park these");
      expect((await liveTriage(app, fresh())).closed).toBe(0);
      expect(state(umbrella).state).toBe("open");
      expect(state(twin).state).toBe("open");
    });

    test("folds plus already-done closes stay within 25 per tick", async () => {
      for (let n = 0; n < MOST_CHANGES + 3; n++) {
        by(alice, `Twin ${n}`);
        by(alice, `twin ${n}`);
      }
      const extra = issue("Done too");
      note(extra, oid);
      expect((await liveTriage(app, fresh())).closed).toBe(MOST_CHANGES);
      expect((await liveTriage(app, fresh())).closed).toBe(4);
    });
  });

  describe("questions", () => {
    beforeAll(() => {
      ensureDirectionIssue(app, alice, fresh());
    });
    const direction = () => getIssueById(app.db, fresh().directionIssueId!)!;
    const lines = () => listComments(app.db, direction().id).map((c) => c.body);
    const outsider = async () => {
      const existing = getUserByName(app.db, "carol");
      if (existing) return existing;
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "carol",
        email: "carol@forge.local",
        password: "a-good-passphrase",
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };

    test("a writer's question folds into the direction issue as one line and closes as dropped", async () => {
      for (const title of ["Question: why sqlite", "Wish: dark mode", "idea: a tui", "Should it sync?"]) {
        const q = issue(title);
        const before = lines().length;
        const did = await liveTriage(app, fresh());
        expect(did.folded).toBe(1);
        expect(lines().slice(before)).toEqual([`Folded: #${q.number} ${title}`]);
        expect(state(q).state).toBe("closed");
        expect(state(q).closeReason).toBe("dropped");
        expect(listComments(app.db, q.id).some((c) => c.body.includes("reopen"))).toBe(true);
      }
    });

    test("an outsider's question is never folded", async () => {
      const carol = await outsider();
      const theirs = issue("Question: placeholder");
      app.db.query(`UPDATE issue SET author_id = ?1 WHERE id = ?2`).run(carol.id, theirs.id);
      const before = lines().length;
      expect((await liveTriage(app, fresh())).folded).toBe(0);
      expect(state(theirs).state).toBe("open");
      expect(lines().length).toBe(before);
    });

    test("a task title stays open, and a reopened fold stays open", async () => {
      const task = issue("Add a dark mode");
      const asked = issue("Wish: export");
      expect((await liveTriage(app, fresh())).folded).toBe(1);
      expect(state(task).state).toBe("open");
      expect(setIssueState(app, alice, fresh(), state(asked), "open").ok).toBe(true);
      const before = lines().length;
      expect((await liveTriage(app, fresh())).folded).toBe(0);
      expect(state(asked).state).toBe("open");
      expect(lines().length).toBe(before);
    });

    test("a close that fails announces no second line and the next tick finishes it", async () => {
      const stuck = issue("Wish: rollback");
      app.db.run(
        `CREATE TRIGGER no_fold_close BEFORE UPDATE ON issue
           WHEN NEW.state = 'closed' AND NEW.title = 'Wish: rollback'
           BEGIN SELECT RAISE(ABORT, 'rolled back'); END`,
      );
      const line = `Folded: #${stuck.number} Wish: rollback`;
      const before = closedEvents();
      try {
        expect((await liveTriage(app, fresh())).folded).toBe(0);
        expect(state(stuck).state).toBe("open");
        expect(closedEvents()).toBe(before);
      } finally {
        app.db.run(`DROP TRIGGER no_fold_close`);
      }
      expect((await liveTriage(app, fresh())).folded).toBe(1);
      expect(state(stuck).state).toBe("closed");
      expect(lines().filter((l) => l === line).length).toBe(1);
    });

    test("a stranger's comment cannot block a fold", async () => {
      const carol = await outsider().catch(() => getUserByName(app.db, "carol")!);
      const q = issue("Idea: wildcard");
      app.db
        .query(`INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
        .run("c-spoof", q.id, carol.id, `${FOLDED_NOTE} nope`, new Date().toISOString());
      expect((await liveTriage(app, fresh())).folded).toBe(1);
      expect(state(q).state).toBe("closed");
    });

    test("an agent's or an imported question is never folded", async () => {
      const agent = issue("Question: by an agent");
      const imported = issue("Question: imported");
      app.db.query(`UPDATE issue SET origin_author = 'stranger' WHERE id = ?1`).run(imported.id);
      app.db.query(`UPDATE user SET is_agent = 1 WHERE id = ?1`).run(alice.id);
      try {
        expect((await liveTriage(app, fresh())).folded).toBe(0);
      } finally {
        app.db.query(`UPDATE user SET is_agent = 0 WHERE id = ?1`).run(alice.id);
      }
      expect(state(agent).state).toBe("open");
      expect(state(imported).state).toBe("open");
      app.db.query(`UPDATE issue SET state = 'closed' WHERE id IN (?1, ?2)`).run(agent.id, imported.id);
    });

    test("folds count toward the cap", async () => {
      const many = Array.from({ length: MOST_CHANGES + 2 }, (_, n) => issue(`Idea: cap ${n}`));
      expect((await liveTriage(app, fresh())).folded).toBe(MOST_CHANGES);
      expect((await liveTriage(app, fresh())).folded).toBe(2);
      expect(many.every((m) => state(m).state === "closed")).toBe(true);
    });
  });
});

/** The one clock the filing tests age issues from and tick at, so no second read of the time can disagree. */
const CLOCK = new Date("2026-01-01T12:00:00.000Z");

describe("live triage files unplaced issues", () => {
  let dir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let umbrella: Issue;
  let gate: Issue;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const open = (title: string, body = "", age = 2 * FILE_AFTER_MS): Issue => {
    const opened = openIssue(app, alice, fresh(), { title, body });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query(`UPDATE issue SET created_at = ?2 WHERE id = ?1`)
      .run(opened.value.id, new Date(CLOCK.getTime() - age).toISOString());
    return getIssueById(app.db, opened.value.id)!;
  };
  const waitsFor = (a: Issue, b: Issue) =>
    app.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM issue_dependency WHERE issue_id = ?1 AND blocked_by_id = ?2`,
      )
      .get(a.id, b.id)!.n === 1;
  const link = (placed: Issue) =>
    app.db
      .query(`INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)`)
      .run(umbrella.id, placed.id);
  const notes = (on: Issue) => listComments(app.db, on.id).filter((c) => c.body.startsWith("Live triage (automatic"));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-livetriage-file-"));
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
    umbrella = open("P0 Trust: be safe");
    gate = open("Later gate: not yet");
  });
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("an issue whose title names a pillar is filed under it, and counted", async () => {
    const work = open("Harden P0 sessions");
    const did = await liveTriage(app, fresh(), CLOCK);
    expect(did.labelled).toBe(1);
    expect(waitsFor(umbrella, work)).toBe(true);
    expect(labelsFor(app.db, work.id).map((l) => l.name)).toContain("P0 Trust");
    expect(notes(work)).toHaveLength(1);
  });

  test("a pillar named only in the body files it", async () => {
    const work = open("Sessions", "This serves p0 trust.");
    await liveTriage(app, fresh(), CLOCK);
    expect(waitsFor(umbrella, work)).toBe(true);
  });

  test("the title wins when title and body name different pillars", async () => {
    const other = open("P1 Speed: be quick");
    const work = open("Cache P1 pages", "Also touches P0.");
    await liveTriage(app, fresh(), CLOCK);
    expect(waitsFor(other, work)).toBe(true);
    expect(waitsFor(umbrella, work)).toBe(false);
  });

  test("a bare pillar name in passing does not file it, and nothing holds it", async () => {
    const work = open("Tell the story of trust", "A story about trust, in passing.");
    await liveTriage(app, fresh(), CLOCK);
    expect(waitsFor(umbrella, work)).toBe(false);
    expect(waitsFor(work, gate)).toBe(false);
  });

  test("an issue naming none is never held: no gate, no label, no comment", async () => {
    const work = open("Add a colour picker");
    const did = await liveTriage(app, fresh(), CLOCK);
    expect(waitsFor(work, gate)).toBe(false);
    expect(labelsFor(app.db, work.id)).toHaveLength(0);
    expect(notes(work)).toHaveLength(0);
    expect(did.labelled).toBe(0);
    expect(did.missed).toBe(0);
  });

  test("an issue under an hour old is left, and a placed one is not moved", async () => {
    const young = open("Brand new idea", "", 60_000);
    const placed = open("Already placed");
    link(placed);
    await liveTriage(app, fresh(), CLOCK);
    expect(waitsFor(young, gate)).toBe(false);
    expect(notes(young)).toHaveLength(0);
    expect(notes(placed)).toHaveLength(0);
    expect(waitsFor(umbrella, placed)).toBe(true);
    expect(waitsFor(placed, gate)).toBe(false);
  });

  test("directions, umbrellas and the gate are skipped", async () => {
    const direction = open("Direction: keep it small");
    app.db.query(`UPDATE repo SET direction_issue_id = ?2 WHERE id = ?1`).run(repo.id, direction.id);
    await liveTriage(app, fresh(), CLOCK);
    for (const furniture of [direction, umbrella, gate]) expect(notes(furniture)).toHaveLength(0);
    expect(waitsFor(direction, gate)).toBe(false);
    expect(waitsFor(gate, gate)).toBe(false);
  });

  test("a person who unfiles a filed issue is not overruled", async () => {
    const work = open("Harden P0 again");
    await liveTriage(app, fresh(), CLOCK);
    app.db.query(`DELETE FROM issue_dependency WHERE blocked_by_id = ?1`).run(work.id);
    const did = await liveTriage(app, fresh(), CLOCK);
    expect(waitsFor(umbrella, work)).toBe(false);
    expect(did.labelled).toBe(0);
    expect(did.missed).toBe(0);
  });
});

describe("live triage where there is little to file under", () => {
  let dir: string;
  let app: App;
  let alice: User;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-livetriage-bare-"));
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
  }, 30_000);
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A repository with the given furniture; `count` old issues naming no pillar. */
  const world = async (name: string, furniture: string[], count: number, stem = "Plain work") => {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const set = await updateRepoSettings(app, alice, made.value, {
      autonomy: "autonomous",
      autonomyDirection: "Keep it small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const repo = () => getRepoById(app.db, made.value.id)!;
    const old = new Date(CLOCK.getTime() - 2 * FILE_AFTER_MS).toISOString();
    const open = (title: string): Issue => {
      const o = openIssue(app, alice, repo(), { title });
      if (!o.ok) throw new Error(String(o.error));
      app.db.query(`UPDATE issue SET created_at = ?2 WHERE id = ?1`).run(o.value.id, old);
      return getIssueById(app.db, o.value.id)!;
    };
    furniture.forEach(open);
    const work = Array.from({ length: count }, (_, n) => open(`${stem} ${n}`));
    return { repo, work };
  };
  const comments = (on: Issue) => listComments(app.db, on.id).length;

  test("an unnamed issue is left alone, and is not counted as missed", async () => {
    const w = await world("unnamed", ["P0 Trust: be safe"], 1);
    const did = await liveTriage(app, w.repo(), CLOCK);
    expect(did.labelled).toBe(0);
    expect(did.missed).toBe(0);
    expect(comments(w.work[0]!)).toBe(0);
    expect(labelsFor(app.db, w.work[0]!.id)).toHaveLength(0);
    const links = app.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM issue_dependency d JOIN issue i ON i.id = d.issue_id WHERE i.repo_id = ?1`,
      )
      .get(w.repo().id)!.n;
    expect(links).toBe(0);
  });

  test("neither pillars nor gate: nothing is filed, counted or written", async () => {
    const w = await world("plain", [], 2);
    expect(await liveTriage(app, w.repo(), CLOCK)).toEqual({ closed: 0, folded: 0, labelled: 0, missed: 0 });
    for (const issue of w.work) expect(comments(issue)).toBe(0);
  });

  test("at most 25 issues are filed per tick; the rest are missed, then filed", async () => {
    const w = await world("many", ["P0 Trust: be safe"], MOST_CHANGES + 1, "Plain P0 work");
    const first = await liveTriage(app, w.repo(), CLOCK);
    expect(first.labelled).toBe(MOST_CHANGES);
    expect(first.missed).toBe(1);
    const second = await liveTriage(app, w.repo(), CLOCK);
    expect(second.labelled).toBe(1);
    expect(second.missed).toBe(0);
    // Twenty-six issues are opened and two ticks run: a loaded check machine must not turn the 5 s default into the verdict.
  }, 30_000);

  test("the tick line carries labelled always and triageMiss only when something was missed", () => {
    expect(tickFields({ closed: 2, folded: 1, labelled: 3, missed: 0 })).toEqual({ triaged: 2, folded: 1, labelled: 3 });
    expect(tickFields({ closed: 0, folded: 0, labelled: 0, missed: 4 })).toEqual({
      triaged: 0,
      folded: 0,
      labelled: 0,
      triageMiss: 4,
    });
  });
});
