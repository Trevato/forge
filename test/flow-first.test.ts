/**
 * The `flow` label alone says what goes first (#7636): no switch, no state.
 * Ready issues labelled `flow` come before older unlabelled ones; with none
 * labelled the order is the one it always was; an assignment is never held;
 * and a writer puts an issue first with one click on the page or the list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { putFlowFirst } from "../src/actions/flow_first.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { labelsFor, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { sweepAssigned } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the flow label goes first", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const open = (title: string): Issue => {
    const o = openIssue(app, alice, fresh(), { title, body: "" });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const ready = () => readyNow(repoGraph(app.db, repo.id)).map((r) => r.issue.title);
  const runsOn = (issue: Issue): number =>
    app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'").get(issue.id)!.n;
  const post = (token: string, path: string, body: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flow-first-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const made = await createRepo(app, alice, { name: "svc", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with no labelled issue, ready work keeps its order and still starts", () => {
    open("old one");
    open("old two");
    expect(ready()).toEqual(["old one", "old two"]);
  });

  test("a labelled issue is ready before older unlabelled work; removing the label puts it back", async () => {
    const late = open("late but flow");
    expect((await putFlowFirst(app, alice, fresh(), late, true)).ok).toBe(true);
    expect(ready()).toEqual(["late but flow", "old one", "old two"]);
    expect(labelsFor(app.db, late.id).map((l) => l.name)).toEqual(["flow"]);
    expect((await putFlowFirst(app, alice, fresh(), late, false)).ok).toBe(true);
    expect(ready()).toEqual(["old one", "old two", "late but flow"]);
  });

  test("a reader neither labels nor makes the label", async () => {
    const [first] = readyNow(repoGraph(app.db, repo.id));
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM label").get()!.n;
    const refused = await putFlowFirst(app, bob, fresh(), first!.issue, true);
    expect(refused.ok).toBe(false);
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM label").get()!.n).toBe(before);
  });

  test("an assignment of unlabelled work is never held", async () => {
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, fresh(), "bot").ok).toBe(true);
    const bot = getUserByName(app.db, "bot")!;
    const plain = open("plain");
    const assigned = assignIssue(app, alice, fresh(), plain, bot);
    if (!assigned.ok) throw new Error(String(assigned.error));
    sweepAssigned(app);
    expect(runsOn(plain)).toBe(1);
    const page = await (await fetch(`${servers.url}/alice/svc/issues/${plain.number}`)).text();
    expect(page).not.toContain("queued: flow only");
  });

  test("the issue page and the list carry one button; posting it labels, and a reader cannot", async () => {
    const target = open("click me");
    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    const cookie = { authorization: `Bearer ${rw}` };
    const list = await (await fetch(`${servers.url}/alice/svc/issues`, { headers: cookie })).text();
    expect(list).toContain(`action="/alice/svc/issues/${target.number}/flow"`);
    const page = await (await fetch(`${servers.url}/alice/svc/issues/${target.number}`, { headers: cookie })).text();
    expect(page).toContain(`/alice/svc/issues/${target.number}/flow`);
    expect(page).toContain("Flow first");

    const bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    await post(bobRw, `/alice/svc/issues/${target.number}/flow`, { flow: "1" });
    expect(labelsFor(app.db, target.id)).toEqual([]);

    const res = await post(rw, `/alice/svc/issues/${target.number}/flow`, { flow: "1", back: "/alice/svc/issues" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/svc/issues");
    expect(labelsFor(app.db, target.id).map((l) => l.name)).toEqual(["flow"]);
    expect(ready()[0]).toBe("click me");

    await post(rw, `/alice/svc/issues/${target.number}/flow`, { flow: "0" });
    expect(labelsFor(app.db, target.id)).toEqual([]);
    const bad = await post(rw, `/alice/svc/issues/${target.number}/flow`, { flow: "maybe" });
    expect(bad.status).toBe(303);
    expect(labelsFor(app.db, target.id)).toEqual([]);
  });

  test("a cross-origin post is refused and labels nothing", async () => {
    const target = open("cross origin");
    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    const res = await fetch(`${servers.url}/alice/svc/issues/${target.number}/flow`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${rw}`, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ flow: "1" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(labelsFor(app.db, target.id)).toEqual([]);
  });

  test("a closed flow issue is not ready, and a flow issue outranks a recently raised one", async () => {
    const old = open("settled flow");
    expect((await putFlowFirst(app, alice, fresh(), old, true)).ok).toBe(true);
    const newest = open("freshly raised");
    expect(ready()[0]).toBe("settled flow");
    expect(ready()).toContain(newest.title);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(old.id);
    expect(ready()).not.toContain("settled flow");
  });

  test("the retired switch is gone from the API", async () => {
    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    const res = await fetch(`${servers.url}/api/v1/repos/alice/svc`, { headers: { authorization: `Bearer ${rw}` } });
    expect(JSON.stringify(await res.json())).not.toContain("flowOnly");
  });
});
