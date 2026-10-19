/**
 * The home's asks without N+1 (#2772). What asks the owner is read from
 * every open pull they may land: whether the crew is on it, whether its
 * review loop handed it to a person, its app. Each of those is one grouped
 * read for the whole set (`test/counts.test.ts`'s rule), and one request
 * reads the set once — the feed under "Needs you" no longer reads it again.
 *
 * Pulls go in as rows, in every state the candidates sort into, so each
 * branch of `askCandidatesFor` is on the measured path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, setCrewRole } from "../src/core/agents.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { activeRunFor, activeRunsFor, createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { handoverOf, handoversOf } from "../src/crew/guard.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { quiet, statements } from "./helpers/statements.ts";

const ZERO = "0".repeat(40);

/** The SQL `work` runs, each statement once per execution. */
async function seen(db: Database, work: () => Promise<void>): Promise<string[]> {
  await quiet(db);
  const door = db as unknown as { query: unknown };
  const original = db.query.bind(db);
  const out: string[] = [];
  door.query = (sql: string) => {
    out.push(sql.replace(/\s+/g, " ").trim());
    return original(sql);
  };
  try {
    await work();
  } finally {
    door.query = original;
  }
  return out;
}

describe("home's asks are read grouped, and once", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: User;
  let builder: User;
  let reviewer: User;
  let assisted: Repo;
  let autonomous: Repo;
  let cookie = "";
  let seq = 0;

  const user = async (username: string, agent: boolean) => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.test`,
      ...(agent
        ? { agent: true, origin: "agent" as const }
        : { password: "a-good-passphrase", origin: "seed" as const, trusted: true }),
    });
    if (!made.ok) throw new Error(`seed ${username}: ${made.error}`);
    return made.value;
  };

  const repo = async (name: string, autonomy: "assisted" | "autonomous") => {
    const made = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name,
      visibility: "public",
      description: name,
    });
    if (!made.ok) throw new Error(`seed repo ${name}: ${made.error}`);
    for (const agent of [builder, reviewer]) addCrew(app.db, made.value.id, agent.id, owner.id);
    setCrewRole(app.db, made.value.id, reviewer.id, "reviewer");
    app.db.query("UPDATE repo SET autonomy = ?2 WHERE id = ?1").run(made.value.id, autonomy);
    return made.value;
  };

  const check = (on: Repo, issueId: string, state: "ok" | "failed") => {
    const run = createRun(app.db, { repoId: on.id, kind: "check", issueId, commitOid: ZERO });
    app.db.query("UPDATE run SET state = ?2 WHERE id = ?1").run(run.id, state);
  };

  /** An open pull on `on` by `author`, as rows: its id and number. */
  const filePull = (on: Repo, author: User, title: string) => {
    const issueId = id();
    const number = app.db
      .query<{ issue_seq: number }, [string]>(
        "UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq",
      )
      .get(on.id)!.issue_seq;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
         VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open')`,
      )
      .run(issueId, on.id, number, title, author.id);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
         VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
      )
      .run(issueId, `crew/${++seq}`, ZERO, on.id);
    return { issueId, number };
  };

  const changesRequested = (issueId: string, rounds: number) => {
    for (let r = 0; r < rounds; r++)
      submitReview(app.db, {
        issueId,
        authorId: reviewer.id,
        state: "changes_requested",
        body: `Round ${r}.`,
        commitOid: ZERO,
      });
  };

  /**
   * One open pull in each state that reaches the reads grouped here. A
   * pull with a check result reads more, per pull, on its way to a card
   * (staleness, the reviewer's wait, the retry count): that is #2772's
   * follow-up, not measured here.
   */
  const seedRound = () => {
    const states = ["quiet", "working", "reviewed", "autonomous-quiet"] as const;
    for (const state of states) {
      const on = state.startsWith("autonomous") ? autonomous : assisted;
      const { issueId } = filePull(on, builder, `Pull (${state})`);
      if (state === "working")
        createRun(app.db, { repoId: on.id, kind: "agent", issueId, actorId: builder.id });
      if (state === "reviewed") changesRequested(issueId, 1);
    }
  };

  const home = async () => {
    const response = await fetch(`${servers.url}/asks`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return response.text();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-counts-"));
    app = createApp({ dataDir, port: 0 });
    owner = await user("keeper", false);
    builder = await user("wrench", true);
    reviewer = await user("plumb", true);
    assisted = await repo("shop", "assisted");
    autonomous = await repo("works", "autonomous");
    cookie = `forge_session=${createSession(app.db, owner.id).token}`;
    servers = await serve(app);
  });

  afterAll(async () => {
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("home costs the same for one round of open pulls as for four", async () => {
    seedRound();
    await home();
    const few = await statements(app.db, async () => void (await home()));
    seedRound();
    seedRound();
    seedRound();
    const many = await statements(app.db, async () => void (await home()));
    expect(many).toBe(few);
  });

  test("one request reads the open pulls' active runs and hand-overs once", async () => {
    const sql = await seen(app.db, async () => void (await home()));
    const active = sql.filter((s) => s.includes("state IN ('queued','running')") && s.includes("issue_id IN"));
    const handovers = sql.filter((s) => s.startsWith("SELECT r.issue_id") && s.includes("changes_requested"));
    expect(active.length).toBe(1);
    expect(handovers.length).toBe(1);
  });

  test("the grouped reads agree with the singular ones", () => {
    const handed = filePull(assisted, builder, "Handed over");
    changesRequested(handed.issueId, 3);
    const pulls = app.db
      .query<{ id: string; repoId: string }, []>(
        "SELECT id, repo_id AS repoId FROM issue WHERE kind = 'pull' AND state = 'open'",
      )
      .all();
    const repoOf = (repoId: string) => (repoId === assisted.id ? assisted : autonomous);
    const active = activeRunsFor(app.db, "agent", pulls.map((p) => p.id));
    const over = handoversOf(app.db, pulls.map((p) => ({ id: p.id, repo: repoOf(p.repoId) })));
    for (const p of pulls) {
      expect(active.get(p.id)).toEqual(activeRunFor(app.db, "agent", p.id));
      expect(over.get(p.id)).toEqual(handoverOf(app.db, repoOf(p.repoId), p.id));
    }
    expect(over.has(handed.issueId)).toBe(true);
    expect(active.size).toBeGreaterThan(0);
  });

  test("a green pull on an app still offers its preview", async () => {
    const green = filePull(assisted, owner, "Green and waiting");
    check(assisted, green.issueId, "ok");
    expect(await home()).not.toContain(`/app/pull-${green.number}/open`);
    const made = createAppRecord(app.db, { repoId: assisted.id, slug: "shop", access: "public" });
    expect(made.ok).toBe(true);
    expect(await home()).toContain(`/app/pull-${green.number}/open`);
  });
});
