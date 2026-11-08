/**
 * The `steer` tool is the API's steer over MCP: the same action, so the same
 * gate. A writer's rw token steers an agent run and the words are recorded; an
 * ro token, a reader, an empty text and a non-agent run are each refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { steerRefusedWords } from "../src/actions/steer_words.ts";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { openIssue } from "../src/actions/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { listComments } from "../src/core/issues.ts";
import { createRun, type Run } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("MCP steer", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRw: string;
  let aliceRo: string;
  let bobRw: string;
  let agentRun: Run;
  let deployRun: Run;
  let issueId: string;
  let id = 1;

  const tool = async (token: string, args: unknown) => {
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
        params: { name: "steer", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-steer-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    const alice = getUserByName(app.db, "alice")!;
    const made = await newApp(app, alice, { name: "hello", visibility: "public" } as never);
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "hello")!;
    const opened = openIssue(app, alice, repo, { title: "Paint the fence" });
    if (!opened.ok) throw new Error(String(opened.error));
    issueId = opened.value.id;
    agentRun = createRun(app.db, { repoId: repo.id, kind: "agent", issueId });
    deployRun = createRun(app.db, { repoId: repo.id, kind: "deploy" as never });
    aliceRw = tokenFor(app, "alice", "rw");
    aliceRo = tokenFor(app, "alice", "ro");
    bobRw = tokenFor(app, "bob", "rw");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const said = () => listComments(app.db, issueId).map((c) => c.body);

  test("a writer steers an agent run and the words are recorded", async () => {
    const r = await tool(aliceRw, { repo: "alice/hello", run: agentRun.id, text: "paint it blue" });
    expect(r.value.outcome).toBe("commented");
    expect(typeof r.value.says).toBe("string");
    expect(said()).toContain("paint it blue");
  });

  test("an ro token, a reader, an empty text and a non-agent run are refused", async () => {
    const ro = await tool(aliceRo, { repo: "alice/hello", run: agentRun.id, text: "no" });
    expect(ro.error).toBeDefined();
    const reader = await tool(bobRw, { repo: "alice/hello", run: agentRun.id, text: "reader words" });
    expect(reader.error).toContain("forbidden");
    const empty = await tool(aliceRw, { repo: "alice/hello", run: agentRun.id, text: "   " });
    expect(empty.error).toContain("empty");
    const other = await tool(aliceRw, { repo: "alice/hello", run: deployRun.id, text: "hi" });
    expect(other.error).toContain("not_agent");
    expect(said()).not.toContain("no");
    expect(said()).not.toContain("reader words");
  });

  test("each refusal is worded as the run page's steer box words it", async () => {
    const said = (r: { error?: string }, code: string) => {
      expect(r.error).toContain(code);
      expect(r.error).toContain(steerRefusedWords(code));
    };
    said(await tool(bobRw, { repo: "alice/hello", run: agentRun.id, text: "x" }), "forbidden");
    said(await tool(aliceRw, { repo: "alice/hello", run: agentRun.id, text: " " }), "empty");
    said(await tool(aliceRw, { repo: "alice/hello", run: deployRun.id, text: "hi" }), "not_agent");
    said(await tool(aliceRw, { repo: "alice/hello", run: "nope", text: "hi" }), "not_found");
    // The run page: the flash it redirects with carries the same sentence.
    for (const [token, code] of [[bobRw, "forbidden"], [aliceRw, "empty"]] as const) {
      const page = await fetch(`${servers.url}/alice/hello/runs/${agentRun.id}/steer`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
          origin: servers.url,
        },
        body: new URLSearchParams({ text: code === "empty" ? " " : "x" }),
      });
      expect(page.status).toBe(303);
      const flash = decodeURIComponent(
        `${page.headers.get("location")} ${page.headers.get("set-cookie")}`.replace(/\+/g, " "),
      );
      expect(flash).toContain(steerRefusedWords(code));
    }
    for (const code of ["empty", "not_agent", "not_found", "unauthorized", "unverified", "forbidden"])
      expect(steerRefusedWords(code)).not.toContain(code);
  });
});
