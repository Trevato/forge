/**
 * The forge passes its own conformance suite (`standards/`, docs/standards/):
 * the suite is run, as a separate process speaking only HTTP, against this
 * forge and a minimal reference app (opt-in: FORGE_CONFORMANCE=1). Also: the
 * pages and the index agree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { STANDARDS } from "../src/core/standards_index.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { running } from "../src/kernel/version.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the forge standards", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token = "";
  let reference: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-standards-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    token = createToken(app.db, made.value.id, "standards", "rw").token;
    // The smallest app that conforms: health, identity it never trusts, an adapter's signed pull.
    reference = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/healthz") return Response.json({ ok: true, version: "0", uptime: 1 });
        if (path === "/pull") return new Response("signed admin only", { status: 401 });
        if (path === "/__forge/note") return new Response("not found", { status: 404 });
        return new Response("hello", { status: 200 });
      },
    });
  }, 60_000);

  afterAll(async () => {
    reference.stop(true);
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("/.well-known/forge lists every standard in the index", async () => {
    const res = await fetch(`${servers.url}/.well-known/forge`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { forge: { version: string }; standards: { id: string; version: number }[] };
    expect(doc.forge.version).toBe(running().version);
    expect(doc.standards.map((s) => [s.id, s.version])).toEqual(STANDARDS.map((s) => [s.id, s.version]));
  });

  test("each standard has a page that states the same version, and the README lists it", async () => {
    const readme = await readFile("docs/standards/README.md", "utf8");
    for (const s of STANDARDS) {
      const page = await readFile(`docs/standards/${s.id}.md`, "utf8");
      expect(page).toContain(`\nVersion: ${s.version}\n`);
      expect(readme).toContain(`(${s.id}.md)`);
    }
  });

  test("a missing repository answers a stranger's report 404, and anonymous app notes 401", async () => {
    const report = await fetch(`${servers.url}/api/v1/repos/nobody-here/none/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(report.status).toBe(404);
    expect((await fetch(`${servers.url}/api/v1/repos/nobody-here/none/app/notes`)).status).toBe(401);
  });

  // The black-box run boots a nested `bun test`, creates scratch repositories and posts
  // through the rate limiter: slow, so it is opt-in (FORGE_CONFORMANCE=1), not in the check.
  test.skipIf(process.env["FORGE_CONFORMANCE"] !== "1")("the forge and a reference app pass the conformance suite", async () => {
    const proc = Bun.spawn(["bun", "test", "./standards/"], {
      env: { ...process.env, FORGE_URL: servers.url, FORGE_TOKEN: token, APP_URL: `http://127.0.0.1:${reference.port}`, APP_ADAPTER: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.error(out + err);
    expect(err).not.toContain("(skip)");
    expect(code).toBe(0);
  }, 120_000);
});
