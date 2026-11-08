/** A failed run's post names its pull or issue and its first error line, and links to that line (#5812). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceRun } from "../src/actions/runs.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { firstErrorLine } from "../src/runs/error_line.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { serve, type Servers } from "../src/http/server.ts";

const WORDS = "an agent run on #1 failed: error: Cannot find module './nope' from src/a.ts";

describe("a failed run's feed post", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;
  let token: string;
  let bobCookie: string;
  let bobToken: string;
  let runId: string;
  let ranOn: number;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-feed-failed-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
    token = createToken(app.db, u.value.id, "ro", "ro").token;
    const b = await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob",
      email: "bob@forge.local", password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bobCookie = `forge_session=${createSession(app.db, b.value.id).token}`;
    bobToken = createToken(app.db, b.value.id, "ro", "ro").token;
    const made = await createRepo(app, u.value, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = createIssue(app.db, { repoId: made.value.id, authorId: u.value.id, title: "Water" });
    if (!issue.ok) throw new Error(issue.error);
    ranOn = issue.value.number;
    const run = createRun(app.db, {
      repoId: made.value.id, kind: "agent", issueId: issue.value.id, actorId: u.value.id,
    });
    runId = run.id;
    claimRun(app.db, run.id);
    for (const line of ["→ read src/a.ts", "I will fix it", "error: Cannot find module './nope' from src/a.ts", "error: later"])
      appendRunLog(dataDir, run.id, line);
    const done = finishRun(app.db, run.id, { state: "failed", summary: "the run failed" });
    announceRun(app, done!, u.value.id);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the first error marker is found, cut to 120 chars, with its line number", () => {
    expect(firstErrorLine(["ok", "fine"])).toBeUndefined();
    expect(firstErrorLine(["a", `Error: ${"x".repeat(200)}`, "error: two"])).toEqual({
      text: `Error: ${"x".repeat(112)}…`,
      at: 2,
    });
  });

  test("home reads the words and links to the line", async () => {
    expect(ranOn).toBe(1);
    const text = await (await fetch(`${servers.url}/feed`, { headers: { cookie: `${cookie}; forge_mode=studio` } })).text();
    expect(text).toContain("an agent run on #1 failed: error: Cannot find module");
    expect(text).toContain(`/alice/garden/runs/${runId}?all=1#L3`);
  });

  test("MCP feed carries the same words and link", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed", arguments: {} } }),
    });
    const body: any = await res.json();
    const items: { what: string; link: string }[] = JSON.parse(body.result.content[0].text).items;
    const post = items.find((i) => i.what.includes("failed"))!;
    expect(post.what).toBe(WORDS);
    expect(post.link).toBe(`/alice/garden/runs/${runId}?all=1#L3`);
  });

  test("a reader who is not crew gets the summary and the plain link, never the log line", async () => {
    const home = await (await fetch(`${servers.url}/feed`, { headers: { cookie: `${bobCookie}; forge_mode=studio` } })).text();
    expect(home).toContain("failed");
    expect(home).not.toContain("Cannot find module");
    expect(home).not.toContain("#L3");
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed", arguments: {} } }),
    });
    const raw: string = ((await res.json()) as any).result.content[0].text;
    expect(raw).not.toContain("Cannot find module");
    const post = (JSON.parse(raw).items as { what: string; link: string }[]).find((i) => i.what.includes("failed"))!;
    expect(post.what).toBe("an agent run on #1 failed: the run failed");
    expect(post.link).toBe(`/alice/garden/runs/${runId}`);
    const events = await fetch(`${servers.url}/api/v1/repos/alice/garden/events`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    const body = await events.text();
    expect(body).toContain("run.finished");
    expect(body).not.toContain("errorLine");
    expect(body).not.toContain("Cannot find module");
  });

  test("the run page numbers its rows so the link lands", async () => {
    const text = await (await fetch(`${servers.url}/alice/garden/runs/${runId}?all=1`, { headers: { cookie } })).text();
    expect(text).toContain('id="L3"');
  });
});
