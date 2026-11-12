/**
 * A note from a person is assigned to a builder on arrival, a flow alarm
 * names one that waits, and the planner opens nothing while one is
 * unanswered (#10563).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendNote, type Sender } from "../src/actions/app_notes.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPlan } from "../src/actions/plan.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { hideNote, notesOfApp } from "../src/core/app_notes.ts";
import { createRun } from "../src/core/runs.ts";
import { addComment, getIssue } from "../src/core/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { alarmFromApp } from "../src/flow/alarm_from_app.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const input = { text: "the button is too small", page: "", viewport: "390x844" };
const MIN = 60_000;

describe("a person's note from an app", () => {
  let dataDir = "";
  let app: App;
  let owner: User;
  let builder: User;
  let planner: User;
  let repo: Repo;
  let seq = 0;
  const person = (tag = ""): Sender => ({ key: `u:${owner.id}${tag}`, name: owner.username, person: true });
  const stranger: Sender = { key: "v:abc", name: "visitor-abc", person: false };

  const send = async (who: Sender) => {
    const record = getAppBySlug(app.db, "shop")!;
    const sent = await sendNote(app, record, repo, "production", undefined, who, input, `10.8.0.${++seq}`);
    if (!sent.ok) throw new Error(sent.error.message);
    return app.db.query<{ number: number }, [string]>("SELECT MAX(number) AS number FROM issue WHERE repo_id = ?1").get(repo.id)!.number;
  };
  const close = (n: number) => app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND number = ?2").run(repo.id, n);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-alarm-from-app-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const mk = async (username: string, agent: boolean) => {
      const made = await createUser(app.db, {
        username,
        email: `${username}@forge.test`,
        ...(agent ? { agent: true, origin: "agent" as const } : { password: "a-good-passphrase", origin: "seed" as const, trusted: true, adminIfFirst: true }),
      });
      if (!made.ok) throw new Error(String(made.error));
      if (agent) createAgentRow(app.db, { userId: made.value.id, roles: [username === "plan" ? "planner" : "builder"] });
      return made.value;
    };
    owner = await mk("alice", false);
    builder = await mk("build", true);
    planner = await mk("plan", true);
    const made = await newApp(app, owner, { name: "shop", description: "Words", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = getRepo(app.db, "alice", "shop")!;
    addCrew(app.db, repo.id, builder.id, owner.id, "builder");
    addCrew(app.db, repo.id, planner.id, owner.id, "planner");
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("is assigned to a builder when it is filed; a stranger's is not", async () => {
    const n = await send(person());
    expect(getIssue(app.db, repo.id, n)!.assigneeName).toBe("build");
    const s = await send(stranger);
    expect(getIssue(app.db, repo.id, s)!.assigneeName).toBeNull();
    close(n);
    close(s);
  });

  test("the alarm fires at 15 minutes unassigned, or an hour without a crew comment, and names the issue", async () => {
    const n = await send(person());
    app.db.query("UPDATE issue SET assignee_id = NULL WHERE repo_id = ?1 AND number = ?2").run(repo.id, n);
    const at = Date.now();
    expect(alarmFromApp(app.db, new Date(at + 14 * MIN)).fired).toBe(false);
    const unassigned = alarmFromApp(app.db, new Date(at + 16 * MIN));
    expect(unassigned.fired).toBe(true);
    expect(unassigned.says).toContain(`alice/shop#${n}`);
    expect(unassigned.says).toContain("unassigned");
    expect(firedAlarms(app.db, new Date(at + 16 * MIN), { dataDir: null }).map((a) => a.key)).toContain("from_app");
    // Assigned: quiet until the hour.
    app.db.query("UPDATE issue SET assignee_id = ?3 WHERE repo_id = ?1 AND number = ?2").run(repo.id, n, builder.id);
    expect(alarmFromApp(app.db, new Date(at + 59 * MIN)).fired).toBe(false);
    const silent = alarmFromApp(app.db, new Date(at + 61 * MIN));
    expect(silent.fired).toBe(true);
    expect(silent.says).toContain("no crew comment");
    // A crew comment restarts the hour.
    addComment(app.db, { issueId: getIssue(app.db, repo.id, n)!.id, authorId: builder.id, body: "on it" });
    expect(alarmFromApp(app.db, new Date(Date.now() + 30 * MIN)).fired).toBe(false);
    expect(alarmFromApp(app.db, new Date(Date.now() + 61 * MIN)).fired).toBe(true);
    close(n);
    expect(alarmFromApp(app.db, new Date(Date.now() + 5 * 60 * MIN)).fired).toBe(false);
  });

  test("the planner opens no issues in the repo while one is unanswered, and says why", async () => {
    const items = [{ key: "a", title: "Plan item", body: "x", blockedBy: [] }];
    const n = await send(person());
    const refused = openPlan(app, planner, repo, items);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.error).toBe("from_app_waiting");
      expect(refused.error.message).toContain(`#${n}`);
    }
    // A person's plan is not held, nor is a builder's; the crew answering lifts the planner's.
    expect(openPlan(app, owner, repo, [{ key: "p", title: "Person item", body: "x", blockedBy: [] }]).ok).toBe(true);
    const asBuilder = openPlan(app, builder, repo, [{ key: "b", title: "Builder item", body: "x", blockedBy: [] }]);
    expect(asBuilder.ok).toBe(true);
    addComment(app.db, { issueId: getIssue(app.db, repo.id, n)!.id, authorId: builder.id, body: "looking" });
    expect(openPlan(app, planner, repo, items).ok).toBe(true);
  });

  test("with every builder busy the note stays unassigned", async () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: builder.id, reason: "test" });
    const n = await send(person("-b"));
    expect(getIssue(app.db, repo.id, n)!.assigneeName).toBeNull();
    app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(run.id);
    close(n);
  });

  test("a hidden note fires no alarm and holds no planner", async () => {
    const n = await send(person("-c"));
    const record = getAppBySlug(app.db, "shop")!;
    for (const note of notesOfApp(app.db, record.id)) hideNote(app.db, note.id);
    app.db.query("UPDATE issue SET assignee_id = NULL WHERE repo_id = ?1 AND number = ?2").run(repo.id, n);
    expect(alarmFromApp(app.db, new Date(Date.now() + 5 * 60 * MIN)).fired).toBe(false);
    expect(openPlan(app, planner, repo, [{ key: "h", title: "After hidden", body: "x", blockedBy: [] }]).ok).toBe(true);
    close(n);
  });
});
