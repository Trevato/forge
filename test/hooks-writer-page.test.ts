/** A writer who is not an admin follows a failing-webhook line to a page that names who can act (#10196). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { id } from "../src/kernel/id.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let admin = "";
let writer = "";
let reader = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-hooks-writer-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  await mk("alice", true);
  const boss = await mk("boss", false);
  const wendy = await mk("wendy", false);
  const rita = await mk("rita", false);
  const org = createOrg(app.db, "acme", boss.id);
  if (!org.ok) throw new Error(org.error);
  const devs = createTeam(app.db, org.value.id, "devs", "write");
  if (!devs.ok) throw new Error(devs.error);
  addTeamMember(app.db, devs.value, wendy.id);
  app.db.run(
    `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch)
     VALUES (?1, ?2, 'a', 'public', '', 'main')`,
    [id(), org.value.id],
  );
  const cookie = (id: string) => `forge_session=${createSession(app.db, id).token}`;
  admin = cookie(boss.id);
  writer = cookie(wendy.id);
  reader = cookie(rita.id);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
});

const get = (cookie: string) => fetch(`${servers.url}/acme/a/settings/hooks`, { headers: { cookie } });

test("a non-admin writer gets a 200 page naming the admins, with no controls", async () => {
  const res = await get(writer);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("this repository's admins are");
  expect(html).toContain('<a href="/boss">boss</a>');
  expect(html).toContain("Only a repository admin can redeliver or pause a webhook");
  expect(html).not.toContain("Add webhook");
});

test("an admin still gets the settings page", async () => {
  const html = await (await get(admin)).text();
  expect(html).toContain("Add a webhook");
  expect(html).not.toContain("Only a repository admin can redeliver");
});

test("a reader and a visitor are refused as before: 404", async () => {
  expect((await get(reader)).status).toBe(404);
  expect((await get("")).status).toBe(404);
});
