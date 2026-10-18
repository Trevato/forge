/**
 * No sign-up makes the site admin, not even the first account on a forge
 * with no admin at all: the signup form, the API, the passkey door, the
 * terminal's action and the platform edge each make a person who is not an
 * admin. The admin comes
 * from an origin that may make one (a claim; the operator's first-admin code).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { createUser, ensureEdgeUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";
import { fixtureSlot } from "./helpers/slot.ts";

quietLogs();

const PASSWORD = "a-long-family-passphrase";
const dirs: string[] = [];
const apps: App[] = [];
let servers: Servers | undefined;

/** A fresh standalone forge: no account, no admin. */
async function fresh(): Promise<App> {
  const dir = await mkdtemp(join(tmpdir(), "forge-no-signup-admin-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0 });
  apps.push(app);
  return app;
}

const admins = (app: App): number =>
  app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user WHERE is_admin = 1").get()?.n ?? -1;

beforeAll(async () => {
  servers = await serve(await fresh());
});

afterAll(async () => {
  servers?.stop();
  for (const app of apps) app.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("the first account through POST /api/v1/users is not an admin, nor the next", async () => {
  const [app] = apps;
  if (app === undefined || servers === undefined) throw new Error("setup");
  for (const name of ["first", "second"]) {
    const res = await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, email: `${name}@f.test`, password: PASSWORD }),
    });
    expect(res.status).toBe(201);
    expect(getUserByName(app.db, name)?.isAdmin).toBe(false);
  }
  expect(admins(app)).toBe(0);
});

test("the first account through the passkey door is not an admin", async () => {
  const app = await fresh();
  const keyed = await serve(app);
  try {
    const who = { username: "keyed", email: "k@f.test" };
    const fields = await passkeyFields(keyed.url, "/signup/passkey/options", who);
    const res = await fetch(`${keyed.url}/signup/passkey`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...who, ...fields }),
      redirect: "manual",
    });
    expect(res.status).toBeLessThan(400);
    expect(getUserByName(app.db, "keyed")?.isAdmin).toBe(false);
    expect(admins(app)).toBe(0);
  } finally {
    keyed.stop();
  }
});

test("the first account from the terminal's sign-up is not an admin", async () => {
  const app = await fresh();
  const made = await signUp(app, { username: "termy", email: "t@f.test", password: PASSWORD }, { slot: fixtureSlot(app) });
  expect(made.ok && made.value.isAdmin).toBe(false);
  expect(admins(app)).toBe(0);
});

test("the first account the platform edge makes is not an admin", async () => {
  const app = await fresh();
  expect((await ensureEdgeUser(app.db, "edgy", "f.test"))?.isAdmin).toBe(false);
  expect(admins(app)).toBe(0);
});

test("no other origin makes the admin of a forge with none, whatever its door", async () => {
  for (const origin of ["signup", "passkey", "parent"] as const) {
    const app = await fresh();
    const made = await createUser(app.db, { origin, slot: fixtureSlot(app), username: origin, email: `${origin}@f.test` });
    expect(made.ok && made.value.isAdmin).toBe(false);
  }
  for (const origin of ["edge", "everyday", "agent", "spawn"] as const) {
    const app = await fresh();
    const made = await createUser(app.db, { origin, username: origin, email: `${origin}@f.test` });
    expect(made.ok && made.value.isAdmin).toBe(false);
  }
});

test("a claim and the operator's first-admin code still make the admin", async () => {
  for (const origin of ["claim", "first-admin"] as const) {
    const app = await fresh();
    const made = await createUser(app.db, { origin, username: "olive", email: "o@f.test", isAdmin: true, trusted: true });
    expect(made.ok && made.value.isAdmin).toBe(true);
  }
});
