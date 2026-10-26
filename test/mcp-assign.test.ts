/** The `assign` tool does what PUT …/assignee does: a writer assigns and clears; a reader and an unknown user are refused. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, getIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP assign", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceTok: string;
  let carolTok: string;
  let repoId: string;
  let hiddenId: string;
  let bobId: string;
  let botTok: string;
  let id = 1;

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "assign", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const assigneeOf = () => getIssue(app.db, repoId, 1)!.assigneeId;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-assign-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      promote(app.db, u.value);
      return u.value;
    };
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    const carol = await mk("carol");
    bobId = bob.id;
    aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
    carolTok = createToken(app.db, carol.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "one", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.id;
    const issue = createIssue(app.db, { repoId, authorId: alice.id, title: "task" });
    if (!issue.ok) throw new Error(issue.error);
    const pull = createIssue(app.db, { repoId, authorId: alice.id, title: "change", kind: "pull" });
    if (!pull.ok) throw new Error(pull.error);
    const hidden = await createRepo(app, alice, { name: "hidden", visibility: "private" });
    if (!hidden.ok) throw new Error(String(hidden.error));
    hiddenId = hidden.value.id;
    const secret = createIssue(app.db, { repoId: hiddenId, authorId: alice.id, title: "secret" });
    if (!secret.ok) throw new Error(secret.error);
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    await createAgent(app, alice, { username: "idle" });
    if (!addToCrew(app, alice, made.value, "bot").ok) throw new Error("crew");
    botTok = createToken(app.db, bot.value.user.id, "rw", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const args = (assignee: string | null, extra = {}) => ({
    repo: "alice/one",
    number: 1,
    kind: "issue",
    assignee,
    ...extra,
  });

  test("a writer assigns and clears", async () => {
    const set = await call(aliceTok, args("bob"));
    expect(set.value.assignee).toBe("bob");
    expect(assigneeOf()).toBe(bobId);
    const cleared = await call(aliceTok, args(null));
    expect(cleared.value.assignee).toBeNull();
    expect(assigneeOf()).toBeNull();
  });

  test("a writer assigns and clears a pull", async () => {
    const set = await call(aliceTok, args("bob", { kind: "pull", number: 2 }));
    expect(set.value.assignee).toBe("bob");
    expect(getIssue(app.db, repoId, 2)!.assigneeId).toBe(bobId);
    await call(aliceTok, args(null, { kind: "pull", number: 2 }));
    expect(getIssue(app.db, repoId, 2)!.assigneeId).toBeNull();
  });

  test("a reader is refused with the API's words", async () => {
    const got = await call(carolTok, args("bob"));
    const api = await fetch(`${servers.url}/api/v1/repos/alice/one/issues/1/assignee`, {
      method: "PUT",
      headers: { authorization: `Bearer ${carolTok}`, "content-type": "application/json" },
      body: JSON.stringify({ assignee: "bob" }),
    });
    expect(api.status).toBe(403);
    const apiBody: any = await api.json();
    expect(got.error).toBe(`forbidden: ${apiBody.message}`);
    expect(assigneeOf()).toBeNull();
  });

  test("an unknown user, a wrong kind and a bad shape are refused", async () => {
    expect((await call(aliceTok, args("nobody"))).error).toStartWith("no_such_user");
    expect((await call(aliceTok, args("bob", { kind: "pull" }))).error).toStartWith("no_such_issue");
    expect((await call(aliceTok, args("bob", { kind: "thing" }))).error).toStartWith("invalid");
    expect((await call(aliceTok, args(5 as any))).error).toStartWith("invalid_assignee");
    expect(assigneeOf()).toBeNull();
  });

  test("an assignee who cannot read the repository is refused, and the assignee stays", async () => {
    const got = await call(aliceTok, args("bob", { repo: "alice/hidden" }));
    expect(got.error).toBe("assignee_cannot_read: the assignee cannot read this repository");
    expect(getIssue(app.db, hiddenId, 1)!.assigneeId).toBeNull();
  });

  test("an agent off the crew is refused as the API refuses it", async () => {
    const got = await call(aliceTok, args("idle"));
    expect(got.error).toBe("agent_not_on_crew: that agent is not on this repository's crew");
    expect(assigneeOf()).toBeNull();
  });

  test("an agent's rw token may not assign, and is told why", async () => {
    const got = await call(botTok, args("bob"));
    expect(got.error).toStartWith("forbidden: an agent may not assign");
    expect(assigneeOf()).toBeNull();
  });
});
