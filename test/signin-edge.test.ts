import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { capacityChanges, capacityValue } from "../src/core/capacity.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";

const TOKEN = "edge-secret-0123456789";

describe("signin.edge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let olive: User;
  const asAda = { "x-plat-user": "ada", "x-plat-edge-token": TOKEN };
  const asOlive = { "x-plat-user": "olive", "x-plat-edge-token": TOKEN };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signin-edge-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: TOKEN });
    servers = await serve(app);
    base = servers.url;
    const made = await seedAdmin(app, {
      username: "olive",
      email: "olive@forge.example",
      password: "correct horse battery",
    });
    if (!made.ok) throw new Error(made.error);
    olive = made.value;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const who = (headers: Record<string, string>) =>
    fetch(`${base}/api/v1/user`, { headers });

  test("on by default; the edge makes an account and signs it in", async () => {
    expect(capacityValue(app.db, "signin.edge")).toBe("on");
    expect((await who(asAda)).status).toBe(200);
    const page = await fetch(`${base}/`).then((r) => r.text());
    expect(page).toContain("/_plat/login");
  });

  test("an admin with no password or passkey cannot turn it off", () => {
    const ada = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'ada'").get();
    if (ada === null) throw new Error("ada was not made");
    const edgeAdmin: User = { ...olive, id: ada.id, username: "ada" };
    const refused = changeCapacity(app, edgeAdmin, "signin.edge", "off");
    expect(refused).toEqual({ ok: false, error: "no_credential" });
    expect(capacityValue(app.db, "signin.edge")).toBe("on");
    expect(changeCapacity(app, edgeAdmin, "signin.edge", "on").ok).toBe(true);
  });

  test("off: the edge's identity is ignored, even for an account it made", async () => {
    const changed = changeCapacity(app, olive, "signin.edge", "off");
    expect(changed.ok).toBe(true);
    expect(capacityChanges(app.db, 1)[0]).toMatchObject({ key: "signin.edge", from: "on", to: "off" });

    expect((await who(asAda)).status).toBe(401);
    expect((await who(asOlive)).status).toBe(401);
    const page = await fetch(`${base}/`, { headers: asAda }).then((r) => r.text());
    expect(page).not.toContain("Sign out");
    expect(page).not.toContain("/_plat/login");
    expect(page).toContain('href="/signin"');
    const gate = await fetch(`${base}/new`, { redirect: "manual", headers: asAda });
    expect(gate.headers.get("location") ?? "").not.toContain("/_plat/");
  });

  test("off: password and passkey sign-in still work", async () => {
    const token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      body: JSON.stringify({ adminConfirm: true, username: "olive", password: "correct horse battery", name: "t", scope: "rw" }),
    });
    expect(token.status).toBe(201);
    const options = await fetch(`${base}/signin/passkey/options`, {
      method: "POST",
      headers: { origin: "https://forge.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(options.status).toBe(200);
  });

  test("back on: the edge is read again", async () => {
    expect(changeCapacity(app, olive, "signin.edge", "on").ok).toBe(true);
    expect((await who(asAda)).status).toBe(200);
  });
});
