import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { recordDrill } from "../src/core/domain_drills.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("Settings → Backups → Failure domains", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-resilience-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error("users");
    }
    recordDrill(app.db, "alice", "snapshots", { health: "", board: "" }, 90, {
      green: true,
      why: "all phrases seen",
    });
    recordDrill(app.db, "alice", "runner", { health: "", board: "" }, 900, {
      green: false,
      why: "<b>late</b> by 5 minutes",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sees a green and a red drill, escaped, and why the rest are not drilled", async () => {
    const res = await fetch(`${servers.url}/settings/backups`, {
      headers: { cookie: await login("alice") },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/class="ok"\s*>green<\/strong\s*>\s*— all phrases seen/);
    expect(text).toMatch(/class="bad"\s*>red<\/strong\s*>\s*— &lt;b&gt;late&lt;\/b&gt; by 5 minutes/);
    expect(text).toContain("&lt;b&gt;late&lt;/b&gt;");
    expect(text).not.toContain("<b>late</b>");
    expect(text).toContain("Filling or detaching the live volume would lose writes.");
    expect(text).toContain("never run");
    expect(text).toContain('id="domains"');
    expect(text).toContain("<h2>Failure domains</h2>");
    expect(text).not.toContain('href="/settings/resilience"');
  });

  test("the old address sends to the card on the backups page", async () => {
    const res = await fetch(`${servers.url}/settings/resilience`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/backups#domains");
  });

  test("a non-admin is refused, an anonymous visitor sent to sign in", async () => {
    const bob = await fetch(`${servers.url}/settings/backups`, {
      headers: { cookie: await login("bob") },
    });
    expect(bob.status).toBe(403);
    expect(await bob.text()).not.toContain("Failure domains");
    const anon = await fetch(`${servers.url}/settings/backups`, { redirect: "manual" });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/signin?next=%2Fsettings%2Fbackups");
  });
});
