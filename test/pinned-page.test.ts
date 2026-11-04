/** The Deploy to… page (#8744): one sign-in, a filled form, admin only, same-origin, and the same deploy as the other doors. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, allowWrite, net as cloudNet } from "../src/actions/cloud.ts";
import { net } from "../src/actions/pinned.ts";
import { getPinned } from "../src/core/pinned.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { deployToHref } from "../src/web/pinned.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const V = "a".repeat(40);
const SOURCE = "https://forge.example.org/trevato/forge";

describe("deploy-to page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let adminTok = "";
  let bobTok = "";
  const base = () => servers.url;
  const get = (path: string, tok?: string) =>
    fetch(base() + path, { redirect: "manual", headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const post = (body: Record<string, string>, tok: string, origin = base()) =>
    fetch(base() + "/deploy-to", {
      method: "POST", redirect: "manual",
      headers: { authorization: `Bearer ${tok}`, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  const good = { name: "acme", account: "main", app: "alice/shop", source: SOURCE, version: V };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pinned-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    adminTok = createToken(app.db, getUserByName(app.db, "alice")!.id, "admin", "admin").token;
    bobTok = createToken(app.db, getUserByName(app.db, "bob")!.id, "admin", "admin").token;
    cloudNet.fetch = async () => new Response(JSON.stringify({ account: { email: "a@b.c", status: "active" } }), { status: 200 });
    const added = await addAccount(app, getUserByName(app.db, "alice"), "digitalocean", "main", "dop_v1_9Zq4TxLm7Kp2Vb8nWcR5");
    if (!added.ok) throw new Error(String(added.error));
    net.fetch = async (url, init) => {
      if (new URL(url).pathname === "/v2/volumes") return new Response(JSON.stringify({ volume: { id: "vol-1" } }), { status: 201 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ droplet: { id: 7 } }), { status: 202 });
    };
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("signed out, the link goes to sign-in and comes back to itself", async () => {
    const link = deployToHref({ app: "alice/shop", source: SOURCE, version: V });
    const r = await get(link);
    expect(r.status).toBe(303);
    const to = r.headers.get("location")!;
    expect(to).toContain("/signin");
    expect(decodeURIComponent(to)).toContain(link);
  });

  test("an admin sees the form filled from the link, escaped", async () => {
    const r = await get(deployToHref({ app: 'alice/shop"><script>', source: SOURCE, version: V }), adminTok);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain(`value="${V}"`);
    expect(t).toContain("alice/shop&quot;&gt;&lt;script&gt;");
    expect(t).toContain("No cloud account can write yet");
    expect(t).not.toContain("<script>");
  });

  test("someone who is not an admin finds nothing", async () => {
    expect((await get("/deploy-to", bobTok)).status).toBe(404);
    expect((await post(good, bobTok)).status).toBe(404);
    expect(getPinned(app.db, "acme")).toBeUndefined();
  });

  test("a cross-origin post is refused", async () => {
    expect((await post(good, adminTok, "https://evil.example")).status).toBe(403);
    expect(getPinned(app.db, "acme")).toBeUndefined();
  });

  test("a bad version re-renders the form with the reason and deploys nothing", async () => {
    const r = await post({ ...good, version: "main" }, adminTok);
    expect(r.status).toBe(422);
    expect(await r.text()).toContain('value="alice/shop"');
    expect(getPinned(app.db, "acme")).toBeUndefined();
  });

  test("with writes allowed the account is offered and a post deploys", async () => {
    allowWrite(app, getUserByName(app.db, "alice"), "digitalocean", "main", true);
    expect(await (await get("/deploy-to", adminTok)).text()).toContain("DigitalOcean / main");
    const r = await post(good, adminTok);
    expect(r.status).toBe(303);
    const p = getPinned(app.db, "acme")!;
    expect(p.version).toBe(V);
    expect(p.state).toBe("running");
  });
});
