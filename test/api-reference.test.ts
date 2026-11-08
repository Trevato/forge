import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { readSpec, rememberSpec } from "../src/apps/api_spec.ts";
import { createApp, type App } from "../src/app.ts";
import { narrow, reference, runnable } from "../src/contract/reference.ts";
import { ROUTES } from "../src/contract/openapi.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { apiScreen, runGet } from "../src/tui/screens/api.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the API reference", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";
  let appId = "";

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${servers.url}${path}`, { headers, redirect: "manual" });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-api-ref-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    const signed = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const created = await newApp(app, made.value, { name: "notes", visibility: "public" } as never);
    if (created.ok) appId = created.value.app.id;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("every route in the contract appears on /api, with no script and no CDN", async () => {
    const res = await get("/api");
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const r of ROUTES) expect(body).toContain(`id="${r.method}${r.path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase())}"`);
    expect(body).toContain("<details");
    expect(body).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z.]*cdn/i);
  });

  test("the search narrows by a word and says how many matched", async () => {
    const body = await (await get("/api?q=openapi")).text();
    expect(body).toContain("match");
    expect(body).toContain("/api/v1/openapi.json");
    expect(body).not.toContain("/api/v1/repos/{owner}/{name}/issues/{number}/comments");
    const none = await (await get("/api?q=zzzzqqq")).text();
    expect(none).toContain("No operation matches");
  });

  test("an input is escaped in the search box", async () => {
    const body = await (await get(`/api?q=${encodeURIComponent('"><script>x</script>')}`)).text();
    expect(body).not.toContain("<script>x</script>");
  });

  test("Try it on a GET answers 200 for a signed-in person, with Server-Timing", async () => {
    const page = await (await get("/api", { cookie })).text();
    expect(page).toContain("data-try");
    const route = ROUTES.find((r) => r.method === "get" && !r.path.includes("{") && r.path === "/api/v1/user");
    expect(route).toBeDefined();
    const res = await get("/api/v1/user", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).not.toBeNull();
  });

  test("an app that serves /openapi.json gets an API tab and a page that renders it", async () => {
    expect(appId).not.toBe("");
    const before = await (await get("/alice/notes/api", { cookie })).text();
    expect(before).toContain("serves no");
    rememberSpec(appId, {
      openapi: "3.1.0",
      paths: { "/notes": { get: { summary: "List <notes>", parameters: [{ name: "q", in: "query", schema: { type: "string" } }] } } },
    });
    const home = await (await get("/alice/notes/api", { cookie })).text();
    expect(home).toContain('href="/alice/notes/api"');
    expect(home).toContain("List &lt;notes&gt;");
    expect(home).toContain("/notes");
    const studio = await (await get("/alice/notes", { cookie })).text();
    expect(studio).toContain('href="/alice/notes/api"');
  });

  test("the reading groups by area and tolerates a hostile document", () => {
    const areas = reference({ paths: { "/api/v1/repos/{o}": { get: { summary: "x" } }, "/health": { post: { tags: ["ops"], requestBody: { content: { "application/json": { schema: { $ref: "#/nope" } } } } } }, "nonsense": 4 } });
    expect(areas.map((a) => a.name)).toEqual(["ops", "repos"]);
    expect(reference("junk")).toEqual([]);
    expect(narrow(areas, "repos").length).toBe(1);
    expect(runnable(areas[1]!.operations[0]!)).toBe(false);
  });

  test("the terminal's API screen lists endpoints and runs a GET", async () => {
    const terminal = headlessTerminal(120, 30);
    const identity = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };
    const { app: tui, session } = createForgeApp(app, identity, { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(apiScreen(session, tui.ctx));
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("operations");
    const answer = await runGet(session, "/api/v1/openapi.json");
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('"openapi"');
  });

  test("readSpec stops reading a body past the cap instead of buffering it", async () => {
    let sent = 0;
    const big = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async pull(c) {
              await Bun.sleep(1);
              sent += 64 * 1024;
              c.enqueue(new Uint8Array(64 * 1024));
            },
          }),
        ),
    });
    const ok = Bun.serve({ port: 0, fetch: () => Response.json({ paths: { "/x": {} } }) });
    try {
      expect(await readSpec(big.port!)).toBeNull();
      expect(sent).toBeLessThan(8 * 1024 * 1024);
      expect(await readSpec(ok.port!)).toEqual({ paths: { "/x": {} } });
    } finally {
      big.stop(true);
      ok.stop(true);
    }
  });
});
