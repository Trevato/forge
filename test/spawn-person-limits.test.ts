/**
 * A person's hosted forges are limited by count and by storage (admin
 * limits `forges.per_person` and `forges.storage_mb`). Past either, the web
 * form, the API and the MCP `spawn` tool each refuse in one plain sentence
 * naming the limit and the person's use. A site admin is not limited.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { LIMITS, limitValue, setLimit } from "../src/settings/limits.ts";
import { heldByPerson, personRefusal } from "../src/spawn/sleep.ts";

const PASSWORD = "a-long-new-forge-passphrase";

describe("per-person forge limits", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";
  let token = "";
  let adminToken = "";
  let bobId = "";
  let adminId = "";
  const url = (p: string) => `${servers.url}${p}`;
  const api = (tok: string, name: string) =>
    fetch(url("/api/v1/forges"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name, apps: [], dryRun: false }),
    });
  const mcp = async (tok: string, name: string) => {
    const res = await fetch(url("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "spawn", arguments: { name, apps: [], dryRun: false } },
      }),
    });
    const r = ((await res.json()) as any).result;
    return { error: r.isError === true, text: r.content[0].text as string };
  };
  const web = (name: string) =>
    fetch(url("/forges/new"), {
      method: "POST",
      headers: { cookie, origin: "https://forge.test" },
      body: new URLSearchParams([["name", name], ["fresh", "a tiny app"], ["do", "spawn"]]),
      redirect: "manual",
    });
  const limit = (key: "forges.per_person" | "forges.storage_mb", n: number | null) => {
    const r = setLimit(app.db, key, n, adminId);
    if (!r.ok) throw new Error(`limit ${key}`);
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-person-limits-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: PASSWORD, isAdmin: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@x.test", password: PASSWORD });
    if (!a.ok || !b.ok) throw new Error("users");
    adminId = a.value.id;
    bobId = b.value.id;
    token = createToken(app.db, b.value.id, "rw", "rw").token;
    adminToken = createToken(app.db, a.value.id, "rw", "rw").token;
    usePlacement(app, hostedPlacement({ host: "https://forge.test", store: memoryBodies(), maxChildren: 50 }));
    useProbe(app, () => ({ live: async () => true }) as never);
    servers = await serve(app);
    const res = await fetch(url("/signin"), {
      method: "POST",
      body: new URLSearchParams({ username: "bob", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the limits are in admin settings with defaults", () => {
    expect(limitValue(app.db, "forges.per_person")).toBe(3);
    expect(limitValue(app.db, "forges.storage_mb")).toBe(1000);
    expect(LIMITS["forges.per_person"].reason.length).toBeGreaterThan(10);
  });

  test("past the count, the API, the MCP and the web each refuse in one sentence", async () => {
    limit("forges.per_person", 1);
    const first = await api(token, "bobs-one");
    expect(first.status).toBe(201);
    const sentence = "you already have 1 forge, the most one person may have (1); remove one first";

    const viaApi = await api(token, "bobs-two");
    expect(viaApi.status).toBe(409);
    expect(((await viaApi.json()) as any).message).toBe(sentence);

    const viaMcp = await mcp(token, "bobs-three");
    expect(viaMcp.error).toBe(true);
    expect(viaMcp.text).toContain(sentence);

    const viaWeb = await web("bobs-four");
    expect(viaWeb.status).toBe(409);
    expect(await viaWeb.text()).toContain("the most one person may have (1)");

    expect((await readdir(join(dir, "spawn"))).sort()).toEqual(["bobs-one.json"]);
  });

  test("a site admin is not limited", async () => {
    expect((await api(adminToken, "alices-one")).status).toBe(201);
    expect((await api(adminToken, "alices-two")).status).toBe(201);
  });

  test("past the storage, the API, the MCP and the web each refuse and name the use", async () => {
    limit("forges.per_person", 50);
    limit("forges.storage_mb", 1);
    // A real child's database and repositories already weigh more than a megabyte.
    const mb = Math.ceil(heldByPerson(dir, bobId) / 1_000_000);
    expect(mb).toBeGreaterThanOrEqual(2);
    expect(personRefusal(app.db, dir, { id: adminId, isAdmin: true })).toBeUndefined();
    const sentence = `your forges already hold ${mb} MB, the most one person's forges may hold (1 MB); remove one first`;

    const viaApi = await api(token, "bobs-five");
    expect(viaApi.status).toBe(409);
    expect(((await viaApi.json()) as any).message).toContain(sentence);

    const viaMcp = await mcp(token, "bobs-six");
    expect(viaMcp.error).toBe(true);
    expect(viaMcp.text).toContain(sentence);

    const viaWeb = await web("bobs-seven");
    expect(viaWeb.status).toBe(409);
    expect(await viaWeb.text()).toContain("the most one person&#39;s forges may hold (1 MB)");

    // Room again once the limit is raised.
    limit("forges.storage_mb", 100);
    expect((await api(token, "bobs-eight")).status).toBe(201);
  });
});
