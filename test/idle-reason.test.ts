/**
 * Why the builders are idle (#7663): one function, four reasons in the
 * dispatcher's order, and null while every builder slot is busy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { noteLimit } from "../src/core/standing.ts";
import { addSubscription, setGrants } from "../src/core/subscriptions.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { idleLine, idleReason } from "../src/crew/idle_reason.ts";

const NOW = new Date("2026-10-02T12:00:00Z");

describe("idleReason", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let n = 0;

  const open = (title: string): Issue => {
    const o = openIssue(app, alice, repo, { title, body: "" });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const set = (sql: string, ...args: (string | number)[]) => app.db.query(sql).run(...args);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-idle-reason-"));
    app = createApp({ dataDir, port: 0 });
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
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // A fresh autonomous repository with one builder, a $10 ceiling and two slots.
  beforeEach(async () => {
    if (repo) set("UPDATE repo SET autonomy = 'off' WHERE id = ?1", repo.id);
    const made = await createRepo(app, alice, { name: `svc${n++}`, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const created = await createAgent(app, alice, { username: `bot${n}` });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, alice, repo, `bot${n}`).ok).toBe(true);
    bot = getUserByName(app.db, `bot${n}`)!;
    set(
      "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_ceiling_usd = 10, autonomy_slots = 2 WHERE id = ?1",
      repo.id,
      alice.id,
    );
  });

  const spend = (usd: number) => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: bot.id });
    set("UPDATE run SET cost_usd = ?2, state = 'ok' WHERE id = ?1", run.id, usd);
  };

  test("every slot busy: null, even with the ceiling spent", () => {
    open("Work");
    for (let i = 0; i < 2; i++) {
      const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: bot.id, reason: "assigned" });
      set("UPDATE run SET state = 'running', cost_usd = 6 WHERE id = ?1", run.id);
    }
    expect(idleReason(app, new Date())).toBeNull();
  });

  test("a reviewer's or planner's run takes no slot", () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: bot.id, reason: "review" });
    set("UPDATE run SET state = 'running' WHERE id = ?1", run.id);
    expect(idleReason(app, NOW)?.word).toBe("nothing ready");
  });

  test("ceiling reached", () => {
    open("Work");
    spend(10);
    expect(idleReason(app, new Date())).toEqual({ word: "ceiling reached", href: "/meter" });
  });

  test("no subscription with headroom", () => {
    open("Work");
    const added = addSubscription(app.db, dataDir, { name: `acct${n}`, token: "sk-ant-api03-idle-reason-test-key" });
    if (!added.ok) throw new Error(String(added.error));
    setGrants(app.db, repo.id, "", [added.value.id]);
    noteLimit(app.db, added.value.id, {
      window: "5h",
      resetsAt: "2026-10-02T14:00:00.000Z",
      observedAt: "2026-10-02T11:00:00.000Z",
      said: "You've hit your session limit",
    });
    expect(idleReason(app, NOW)).toEqual({ word: "no subscription with headroom", href: "/subscriptions" });
  });

  test("nothing ready: no open issue, or every one waits on another", () => {
    expect(idleReason(app, NOW)).toEqual({ word: "nothing ready", href: "/map" });
    const first = open("First");
    const second = open("Second");
    expect(addDependency(app.db, second, first, alice.id).ok).toBe(true);
    set("UPDATE issue SET state = 'closed' WHERE id = ?1", first.id);
    expect(idleReason(app, NOW)).toBeNull();
    set("UPDATE issue SET state = 'closed' WHERE id = ?1", second.id);
    expect(idleReason(app, NOW)?.word).toBe("nothing ready");
  });

  test("the first reason that holds wins: the ceiling before nothing", () => {
    spend(10);
    expect(idleReason(app, new Date())?.word).toBe("ceiling reached");
  });

  test("an issue the dispatcher holds is not ready: a run in flight on the only one says none startable, not nothing ready", () => {
    const only = open("Held by a run");
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: bot.id, reason: "review", issueId: only.id });
    set("UPDATE run SET state = 'running' WHERE id = ?1", run.id);
    // The map still lists it as ready: "nothing ready" would be false.
    expect(idleReason(app, NOW)).toEqual({ word: "none startable", href: "/map" });
  });

  test("the line says the word and the link", () => {
    expect(idleLine({ word: "flow only", href: "/map" })).toBe("Builders idle: flow only (/map)");
  });
});
