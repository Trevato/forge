/**
 * P7 Steering: a tell from the feed composer, the forge pill, a phone's share
 * sheet and the MCP lands as the same kind of tell — one issue in the repo,
 * the same kind and labels, the teller as author, and the crew's builder
 * assigned (which is what starts a run).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { labelsFor, listIssues, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

describe("a tell from the four places", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let token: string;

  const issues = () => listIssues(app.db, repo.id, {});
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: servers.url, ...headers },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  /** The one issue a tell opened, found by its title. */
  const opened = (title: string): Issue => {
    const found = issues().filter((i) => i.title === title);
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-four-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    proveAll(app);
    const r = await newApp(app, u.value, { name: "notes", description: "x", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value.repo;
    const bot = await createAgent(app, u.value, { username: "bot", brief: "Be brief." });
    if (!bot.ok) throw new Error(String(bot.error));
    expect(addToCrew(app, u.value, repo, "bot").ok).toBe(true);
    token = createToken(app.db, u.value.id, "rw", "rw").token;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("each place opens one issue, by alice, assigned to the crew", async () => {
    const before = issues().length;

    // 1. the feed composer's JSON door
    const composer = await fetch(`${servers.url}/api/v1/feed/tells`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ app: "alice/notes", text: "Tell from composer" }),
    });
    expect(composer.status).toBe(201);

    // 2. the pill's form on the forge's own origin, with the app's page
    const pill = await form("/alice/notes/tell", {
      text: "Tell from pill",
      page: "https://notes.apps.test/a",
    });
    expect(pill.status).toBe(200);

    // 3. the share sheet: land on the composer with a draft, then post it
    const landed = await fetch(`${servers.url}/feed?text=${encodeURIComponent("Tell from share")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(landed.status).toBe(200);
    const page = await landed.text();
    expect(page).toMatch(/<textarea[^>]*name="text"[^>]*>Tell from share<\/textarea>/);
    expect(page).toContain('<option value="alice/notes">');
    expect(issues().some((i) => i.title === "Tell from share")).toBe(false);
    const crossOrigin = await form(
      "/tell",
      { app: "alice/notes", text: "Tell from share" },
      { origin: "https://evil.test" },
    );
    expect(crossOrigin.status).toBeGreaterThanOrEqual(400);
    expect(issues().some((i) => i.title === "Tell from share")).toBe(false);
    const shared = await form("/tell", { app: "alice/notes", text: "Tell from share" });
    expect(shared.status).toBeLessThan(400);

    // 4. the MCP tell tool
    const mcp = await mcpTool(servers.url, token, "tell", { repo: "alice/notes", text: "Tell from mcp" });
    expect(mcp.error).toBeUndefined();

    const told = ["composer", "pill", "share", "mcp"].map((p) => opened(`Tell from ${p}`));
    expect(issues()).toHaveLength(before + 4);
    const [first] = told;
    for (const i of told) {
      expect(i.kind).toBe(first!.kind);
      expect(i.state).toBe("open");
      expect(i.authorName).toBe("alice");
      expect(i.assigneeName).toBe("bot");
      expect(i.assigneeIsAgent).toBe(true);
      expect(labelsFor(app.db, i.id).map((l) => l.name)).toEqual(
        labelsFor(app.db, first!.id).map((l) => l.name),
      );
    }
    expect(new Set(told.map((i) => i.number)).size).toBe(4);
  });
});
