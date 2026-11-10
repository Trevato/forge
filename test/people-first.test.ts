/** A person's word starts first (#10365): their comment, their assignment or a from-app note goes ahead of the crew's own picks, bugs and reruns. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { fromAppIssues } from "../src/core/from_app.ts";
import { pickOrder } from "../src/core/next_up.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startOrder } from "../src/crew/dispatch.ts";
import { peopleFirst } from "../src/crew/people_first.ts";

let dir: string;
let app: App;
let alice: User;
let agentId: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "people-first-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const bot = await createUser(app.db, { origin: "seed", trusted: true, username: "scout", email: "scout@forge.local", password: "a-good-passphrase" });
  if (!bot.ok) throw new Error(bot.error);
  agentId = bot.value.id;
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [agentId]);
  app.db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r', ?1, 'r')", [alice.id]);
  for (const name of ["bug", "from-app"]) app.db.run("INSERT INTO label (id, repo_id, name) VALUES (?1, 'r', ?1)", [name]);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

function issue(labels: string[] = []): string {
  n++;
  const id = `i${n}`;
  app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, 'r', ?2, 'issue', 't', ?3, 'open')", [id, n, alice.id]);
  for (const l of labels) app.db.run("INSERT INTO issue_label (issue_id, label_id) VALUES (?1, ?2)", [id, l]);
  return id;
}
const queue = (issueId: string, reason: string, actorId?: string) =>
  createRun(app.db, { repoId: "r", kind: "agent", issueId, reason, ...(actorId === undefined ? {} : { actorId }) });
const assignedBy = (issueId: string, person: boolean) => {
  const number = Number(app.db.query<{ number: number }, [string]>("SELECT number FROM issue WHERE id = ?1").get(issueId)!.number);
  app.bus.append({ kind: "issue.assigned", repoId: "r", actorId: alice.id, payload: { number, assignee: "scout", agent: true, person } });
};

describe("the queue", () => {
  test("a person's comment, a person's assignment and a from-app note start before a pick, a bug and an agent's feedback, each side in its order", () => {
    const pick = issue();
    const bug = issue(["bug"]);
    const botSaid = issue();
    const fromApp = issue(["from-app"]);
    const personSaid = issue();
    const personAssigned = issue();
    const crewAssigned = issue();
    const order = [
      queue(pick, "assigned"),
      queue(bug, "assigned"),
      queue(botSaid, "feedback", agentId),
      queue(fromApp, "assigned"),
      queue(personSaid, "feedback", alice.id),
      queue(personAssigned, "assigned"),
      queue(crewAssigned, "assigned"),
    ];
    assignedBy(personAssigned, true);
    assignedBy(crewAssigned, false);
    const started = startOrder(app).order.map((r) => r.issueId);
    expect(started.slice(0, 3)).toEqual([fromApp, personSaid, personAssigned]);
    // Behind them the bug keeps its place ahead of the rest.
    expect(started.indexOf(bug)).toBeLessThan(started.indexOf(pick));
    expect(started.indexOf(bug)).toBeLessThan(started.indexOf(botSaid));
    expect(started).toHaveLength(order.length);
    app.db.run("DELETE FROM run WHERE repo_id = 'r'");
  });

  test("nothing personal, or everything, leaves the order alone", () => {
    const a = queue(issue(), "assigned");
    const b = queue(issue(), "check_failed");
    expect(peopleFirst(app.db, [a, b], () => false).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(peopleFirst(app.db, [a, b], () => true).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(peopleFirst(app.db, [a], () => true)).toHaveLength(1);
  });
});

describe("the pick order", () => {
  test("a from-app issue goes ahead of the ranked and the rest; the ranked keep their places", () => {
    const ranks = new Map([["r1", 1], ["r2", 2]]);
    const ready = ["x", "r2", "note", "r1", "y"];
    expect(pickOrder(ready, ranks, (s) => s, ["blocked"], new Set(["note"]))).toEqual(["note", "r1", "r2", "x", "y"]);
    expect(pickOrder(ready, ranks, (s) => s)).toEqual(["r1", "r2", "x", "note", "y"]);
  });

  test("fromAppIssues names the labelled ones and no other", () => {
    const note = issue(["from-app"]);
    const plain = issue();
    expect(fromAppIssues(app.db, [note, plain])).toEqual(new Set([note]));
    expect(fromAppIssues(app.db, [])).toEqual(new Set());
  });
});
