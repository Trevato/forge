/**
 * The Settings page moves a repository to another owner (#10099): the block is
 * an admin's, the confirm step carries the field, the POST calls the action,
 * and each refusal comes back on the page as its sentence with the field kept.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/actions/orgs.ts";
import { createRepo } from "../src/actions/repos.ts";
import { TRANSFER_SAID } from "../src/actions/transfer.ts";
import { createRepo as makeRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-transfer-web-passphrase";

describe("moving a repository from Settings", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  const cookies: Record<string, string> = {};

  const post = (path: string, who: string, fields: Record<string, string>, origin: string | false = servers.url) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookies[who]!, ...(origin ? { origin } : {}) },
      body: new URLSearchParams(fields),
    });
  const get = (path: string, who: string) =>
    fetch(`${servers.url}${path}`, { redirect: "manual", headers: { cookie: cookies[who]! } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-transfer-web-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const username of ["alice", "bob", "carol"]) {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: PASSWORD,
        adminIfFirst: username === "alice",
      });
      if (!u.ok) throw new Error(u.error);
      if (username === "alice") alice = u.value;
      if (username === "bob") bob = u.value;
      const res = await fetch(`${servers.url}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username, password: PASSWORD }),
        redirect: "manual",
      });
      cookies[username] = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    }
    const org = createOrg(app, alice, "lab");
    if (!org.ok) throw new Error(org.error);
    for (const name of ["notes", "taken", "other"]) {
      const r = await createRepo(app, alice, { name, visibility: "public" });
      if (!r.ok) throw new Error(String(r.error));
    }
    const mine = await makeRepo(app.db, app.reposRoot, { ownerId: bob.id, name: "mine", visibility: "public" });
    if (!mine.ok) throw new Error(String(mine.error));
    const dup = await createRepo(app, alice, { name: "taken", visibility: "public", owner: "lab" });
    if (!dup.ok) throw new Error(String(dup.error));
  });

  afterAll(async () => {
    await servers.stop();
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the block shows to the admin only, and its confirm step carries the field", async () => {
    const page = await (await get("/alice/notes/settings", "alice")).text();
    expect(page).toContain("Move to another owner");
    const reader = await (await get("/alice/notes/settings", "bob")).text();
    expect(reader).not.toContain("Move to another owner");
    const confirm = await (
      await get(`/-/confirm?to=${encodeURIComponent("/alice/notes/settings/transfer")}&owner=lab`, "alice")
    ).text();
    expect(confirm).toContain('name="owner" value="lab"');
    const other = await (
      await get(`/-/confirm?to=${encodeURIComponent("/alice/notes/settings/transfer")}&owner=lab&evil=x&confirm=y`, "alice")
    ).text();
    expect(other).not.toContain('name="evil"');
    expect(other).not.toContain('value="x"');
    expect(other.match(/<input type="hidden"/g)?.length).toBe(1);
  });

  test("a reader gets 404, and a cross-origin post is refused", async () => {
    expect((await post("/alice/notes/settings/transfer", "bob", { owner: "bob" })).status).toBe(404);
    const res = await post("/alice/notes/settings/transfer", "alice", { owner: "lab" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect((await get("/alice/notes", "alice")).status).toBe(200);
  });

  const refusals: [string, string, string, number][] = [
    ["name taken", "taken", "name_taken", 409],
    ["same owner", "alice", "same_owner", 409],
    ["unknown owner", "nobody", "unknown_owner", 422],
    ["forbidden owner", "carol", "forbidden_owner", 403],
  ];
  for (const [label, owner, key, status] of refusals) {
    test(`refusal: ${label}`, async () => {
      const repo = key === "name_taken" ? "taken" : "other";
      const target = key === "name_taken" ? "lab" : owner;
      const who = key === "forbidden_owner" ? "bob" : "alice";
      const res = await post(`/${who}/${key === "forbidden_owner" ? "mine" : repo}/settings/transfer`, who, { owner: target });
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(text).toContain(TRANSFER_SAID[key as keyof typeof TRANSFER_SAID].replace(/'/g, "&#39;"));
      expect(text).toContain(`value="${target}"`);
    });
  }

  test("a move redirects to Settings at the new path", async () => {
    const res = await post("/alice/notes/settings/transfer", "alice", { owner: "lab" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/lab/notes/settings");
    expect((await get("/lab/notes/settings", "alice")).status).toBe(200);
    expect((await get("/alice/notes", "alice")).status).toBe(308);
  });
});
