/**
 * The planner's one close on a pull (#3301): an agent's pull whose issue is
 * closed. An open issue, a person's pull, a merge and a reopen stay refused.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { listComments } from "../src/core/issues.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the planner closes a pull", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let atlas: User;
  let mason: User;
  let repo: Repo;
  let token: string;

  const seedPull = (by: User, title: string, body: string): Issue => {
    const opened = openIssue(app, by, repo, { title, body });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid)
         VALUES (?1, 'main', ?2, 'a', 'b')`,
      )
      .run(opened.value.id, `f${opened.value.number}`);
    app.db.query("UPDATE issue SET kind = 'pull' WHERE id = ?1").run(opened.value.id);
    return opened.value;
  };
  const patch = (number: number, state: string, as = token) =>
    fetch(`${servers.url}/api/v1/repos/alice/engine/pulls/${number}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
      body: JSON.stringify({ state }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-planner-closes-pull-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "engine", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    for (const name of ["atlas", "mason"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    atlas = getUserByName(app.db, "atlas")!;
    mason = getUserByName(app.db, "mason")!;
    seatAs(app.db, repo.id, atlas.id, "planner");
    token = createToken(app.db, atlas.id, "rw", "rw").token;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("closes an agent's pull whose issue is closed, and says so on the thread", async () => {
    const ask = openIssue(app, alice, repo, { title: "ask" });
    if (!ask.ok) throw new Error("ask");
    expect(setIssueState(app, alice, repo, ask.value, "closed").ok).toBe(true);
    const pull = seedPull(mason, "built", `Closes #${ask.value.number}`);
    const res = await patch(pull.number, "closed");
    expect(res.status).toBe(200);
    expect(getIssueById(app.db, pull.id)!.state).toBe("closed");
    expect(listComments(app.db, pull.id).some((c) => c.body.startsWith("Closed by the planner"))).toBe(true);
    // Closing only: it may not reopen.
    expect((await patch(pull.number, "open")).status).toBe(403);
  });

  test("refuses an agent's pull whose issue is still open", async () => {
    const ask = openIssue(app, alice, repo, { title: "still wanted" });
    if (!ask.ok) throw new Error("ask");
    const pull = seedPull(mason, "built", `Closes #${ask.value.number}`);
    const res = await patch(pull.number, "closed");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain("issue is closed");
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  });

  test("refuses a person's pull", async () => {
    const ask = openIssue(app, alice, repo, { title: "done ask" });
    if (!ask.ok) throw new Error("ask");
    expect(setIssueState(app, alice, repo, ask.value, "closed").ok).toBe(true);
    const pull = seedPull(alice, "mine", `Closes #${ask.value.number}`);
    expect((await patch(pull.number, "closed")).status).toBe(403);
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  });

  test("refuses a crew agent who is not the planner", async () => {
    const ask = openIssue(app, alice, repo, { title: "shipped ask" });
    if (!ask.ok) throw new Error("ask");
    expect(setIssueState(app, alice, repo, ask.value, "closed").ok).toBe(true);
    const pull = seedPull(atlas, "built", `Closes #${ask.value.number}`);
    const builder = createToken(app.db, mason.id, "rw", "rw").token;
    expect((await patch(pull.number, "closed", builder)).status).toBe(403);
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  });
});
