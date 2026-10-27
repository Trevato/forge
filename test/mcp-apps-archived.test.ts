/** MCP `apps` with `archived: true` lists the apps put away, as /apps?archived=1 does. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("MCP apps archived", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: string;
  let bob: string;
  let id = 1;

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "apps", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) as any[] };
  };
  const names = (r: { value?: any[] }) => (r.value ?? []).map((a) => a.app).sort();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-apps-archived-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    const a = getUserByName(app.db, "alice")!;
    for (const [name, visibility] of [["kept", "public"], ["shelved", "public"], ["vault", "private"]] as const) {
      const made = await newApp(app, a, { name, visibility } as never);
      if (!made.ok) throw new Error(String(made.error));
    }
    alice = tokenFor(app, "alice", "rw");
    bob = tokenFor(app, "bob", "rw");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an archived app leaves the list and shows under archived: true", async () => {
    expect(names(await call(alice, {}))).toEqual(["alice/kept", "alice/shelved", "alice/vault"]);
    const at = new Date().toISOString();
    for (const n of ["shelved", "vault"])
      app.db.query("UPDATE repo SET archived_at = ?2 WHERE id = ?1").run(getRepo(app.db, "alice", n)!.id, at);
    expect(names(await call(alice, {}))).toEqual(["alice/kept"]);
    const gone = await call(alice, { archived: true });
    expect(names(gone)).toEqual(["alice/shelved", "alice/vault"]);
    expect(gone.value![0].archivedAt).toBe(at);
    expect((await call(alice, { archived: false })).value![0].archivedAt).toBeUndefined();
  });

  test("a stranger sees the public one only, never the private one", async () => {
    expect(names(await call(bob, { archived: true }))).toEqual(["alice/shelved"]);
    expect(names(await call(bob, {}))).toEqual(["alice/kept"]);
  });

  test("another type is refused", async () => {
    for (const archived of ["true", 1, null, {}]) {
      const r = await call(alice, { archived });
      expect(r.error).toMatch(/archived/);
    }
  });
});
