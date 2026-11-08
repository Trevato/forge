/**
 * `signin.edge` off, end to end through the doors a person uses (#9048):
 * an edge-only admin is refused on Settings → Capacity, the owner turns it
 * off there, the edge's headers then sign no one in, the owner signs in by
 * passkey and by password, and turns it back on from the same page.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { capacityChanges, capacityValue } from "../src/core/capacity.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { device, type Device } from "./helpers/passkey.ts";

const TOKEN = "edge-secret-0123456789";
const PASSWORD = "correct horse battery";

describe("signin.edge off: the owner signs in by passkey and turns it back on", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner = "";
  let key: Device;
  const asAda = { "x-plat-user": "ada", "x-plat-edge-token": TOKEN };
  const asOlive = { "x-plat-user": "olive", "x-plat-edge-token": TOKEN };

  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: JSON.stringify(body),
    });
  const setEdge = (value: string, headers: Record<string, string>) =>
    fetch(`${base}/settings/capacity`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
      body: new URLSearchParams({ key: "signin.edge", value }),
    });
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const who = (headers: Record<string, string>) => fetch(`${base}/api/v1/user`, { headers });
  const passwordSignin = () =>
    fetch(`${base}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ username: "olive", password: PASSWORD }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signin-edge-off-"));
    app = createApp({ dataDir, port: 0, edgeToken: TOKEN });
    servers = await serve(app);
    base = servers.url;
    const olive = await seedAdmin(app, { username: "olive", email: "olive@forge.example", password: PASSWORD });
    if (!olive.ok) throw new Error(olive.error);
    // An admin the edge made: no password, no passkey.
    const ada = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!ada.ok) throw new Error(ada.error);

    owner = cookieOf(await passwordSignin());
    key = await device(new URL(base).origin);
    const opts = (await (await json("/settings/passkeys/options", {}, { cookie: owner })).json()) as { challenge: string };
    const enrolled = await json("/settings/passkeys", { name: "laptop", challenge: opts.challenge, ...(await key.create(opts.challenge)) }, { cookie: owner });
    expect(enrolled.status).toBe(200);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("Settings → Capacity shows signin.edge, on", async () => {
    expect(capacityValue(app.db, "signin.edge")).toBe("on");
    const page = await (await fetch(`${base}/settings/capacity`, { headers: { cookie: owner } })).text();
    expect(page).toContain('name="key" value="signin.edge"');
    expect((await who(asAda)).status).toBe(200);
  });

  test("an edge-only admin is refused on the page: it would lock them out", async () => {
    const refused = await setEdge("off", asAda);
    expect(refused.status).toBe(303);
    expect(capacityValue(app.db, "signin.edge")).toBe("on");
  });

  test("the owner turns it off on the page; the edge's headers sign no one in", async () => {
    expect((await setEdge("off", { cookie: owner })).status).toBe(303);
    expect(capacityValue(app.db, "signin.edge")).toBe("off");
    expect(capacityChanges(app.db, 1)[0]).toMatchObject({ key: "signin.edge", from: "on", to: "off" });
    expect((await who(asAda)).status).toBe(401);
    expect((await who(asOlive)).status).toBe(401);
    // Nor can the edge, now ignored, turn it back on.
    await setEdge("on", asAda);
    expect(capacityValue(app.db, "signin.edge")).toBe("off");
  });

  test("off: the owner signs in by password and by passkey", async () => {
    const byPassword = cookieOf(await passwordSignin());
    expect(byPassword).toStartWith("forge_session=");
    const o = (await (await json("/signin/passkey/options", {})).json()) as { challenge: string };
    const signed = await json("/signin/passkey", { challenge: o.challenge, ...(await key.get(o.challenge)) });
    expect(signed.status).toBeLessThan(400);
    owner = cookieOf(signed);
    expect(owner).toStartWith("forge_session=");
    const me = await fetch(`${base}/settings/capacity`, { headers: { cookie: owner } });
    expect(me.status).toBe(200);
  });

  test("the passkey session turns it back on from the page, and the edge is read again", async () => {
    expect((await setEdge("on", { cookie: owner })).status).toBe(303);
    expect(capacityValue(app.db, "signin.edge")).toBe("on");
    expect(capacityChanges(app.db, 1)[0]).toMatchObject({ key: "signin.edge", from: "off", to: "on" });
    expect((await who(asAda)).status).toBe(200);
  });
});
