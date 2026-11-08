/** `/settings/people` says what a guest cannot do and what only an admin can, in the words of `roles.ts` (#7200). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { ABILITIES, NOT_AN_ADMIN, adminOnly, guestLacks, roleLimits } from "../src/core/roles.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-people-limits-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("the sentences come from the table and the refusal words", () => {
  expect(roleLimits()).toBe(
    "A guest cannot create a repository or copy an app, or run a crew on a model allowance. " +
      "Only an admin can change the forge's settings or its releases.",
  );
});

test("the guest sentence names every row a guest lacks; the admin sentence is the refusal", () => {
  const [guest, admin] = roleLimits().split(". ");
  expect(guestLacks().length).toBeGreaterThan(0);
  for (const a of guestLacks()) expect(guest!.toLowerCase()).toContain(ABILITIES[a].toLowerCase());
  expect(adminOnly()).toEqual(["administer"]);
  expect(admin!.toLowerCase()).toBe(`${NOT_AN_ADMIN}.`);
});

test("an admin reads what a guest cannot do, and not that nothing is refused", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}/settings/people`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const text = (await res.text()).replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ");
  expect(text).toContain(
    "A guest cannot create a repository or copy an app, or run a crew on a model allowance.",
  );
  expect(text).toContain("Only an admin can change the forge's settings or its releases.");
  expect(text).toContain(roleLimits());
  for (const a of guestLacks()) expect(text.toLowerCase()).toContain(ABILITIES[a].toLowerCase());
  expect(text).not.toContain("nothing is refused");
});
