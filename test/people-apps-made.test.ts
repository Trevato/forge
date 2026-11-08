/** `/settings/people` says what each person made: 0, 1 and many apps as links, and "no allowance" for a member without one. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { appsMade } from "../src/web/pages/people.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

const seed = async (username: string, admin = false) => {
  const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: admin });
  if (!u.ok) throw new Error(u.error);
  return u.value;
};
const makeApp = (ownerId: string, name: string, visibility: "public" | "private") => {
  const repo = `r-${name}`;
  app.db.query("INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)").run(repo, ownerId, name, visibility);
  app.db.query("INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, ?3, ?4)").run(`a-${name}`, repo, name, visibility);
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-people-apps-"));
  app = createApp({ dataDir: root, port: 0 });
  await seed("alice", true);
  const one = await seed("one-app");
  const two = await seed("two-apps");
  await seed("no-apps");
  makeApp(one.id, "solo", "public");
  makeApp(two.id, "zeta", "private");
  makeApp(two.id, "alpha", "public");
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, { method: "POST", headers: { origin: servers.url }, body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("appsMade lists every owner's apps by name, private ones too", () => {
  const made = appsMade({ app } as never);
  expect(made.get("one-app")).toEqual(["solo"]);
  expect(made.get("two-apps")).toEqual(["alpha", "zeta"]);
  expect(made.has("no-apps")).toBe(false);
});

test("each person's row says how many apps and links them; no allowance is said plainly", async () => {
  const text = await (await fetch(`${servers.url}/settings/people`, { headers: { cookie } })).text();
  const row = (name: string) => text.split("<tr>").find((r) => r.includes(`<a href="/${name}"`))!.replace(/\s+/g, " ");
  expect(row("no-apps")).toContain("No apps yet");
  expect(row("one-app")).toContain("1 app");
  expect(row("one-app")).toContain('<a href="/one-app/solo">solo</a>');
  expect(row("two-apps")).toContain("2 apps");
  expect(row("two-apps")).toContain('<a href="/two-apps/alpha">alpha</a>, <a href="/two-apps/zeta">zeta</a>');
  expect(row("two-apps")).toContain("no allowance");
});
