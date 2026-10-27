/**
 * FLOW ONLY said quietly (#6394): one line on the repository header and one
 * per repository on its admin's home while the switch is on; none when off.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const LINE = "Flow only: building flow issues alone";
let dataDir: string;
let app: App;
let servers: Servers;
let owner: User;
let repo: Repo;

const get = async (path: string, who?: User): Promise<string> =>
  (
    await fetch(`${servers.url}${path}`, {
      headers: who ? { cookie: `forge_session=${createSession(app.db, who.id).token}` } : {},
    })
  ).text();
const setSwitch = (on: boolean) => {
  const r = getRepoById(app.db, repo.id)!;
  updateRepoSettings(app.db, r, { flowOnly: on });
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-flow-line-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "maker",
    email: "maker@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error("user");
  owner = made.value;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "svc", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  repo = r.value;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the line is absent while the switch is off, on the header and the home", async () => {
  expect(await get("/maker/svc")).not.toContain(LINE);
  expect(await get("/?all=1", owner)).not.toContain(LINE);
});

test("the repository header links to the setting for its admin", async () => {
  setSwitch(true);
  const asOwner = await get("/maker/svc", owner);
  expect(asOwner).toContain(LINE);
  expect(asOwner).toContain('href="/maker/svc/settings/crew#flow-only"');
  setSwitch(false);
  expect(await get("/maker/svc")).not.toContain(LINE);
});

test("a reader who is not admin sees the words with no link to the setting", async () => {
  setSwitch(true);
  const anon = await get("/maker/svc");
  expect(anon).toContain(LINE);
  expect(anon).not.toContain("#flow-only");
  setSwitch(false);
});

test("the owner's home says it once for the repository", async () => {
  setSwitch(true);
  const home = await get("/?all=1", owner);
  expect(home.split(LINE).length - 1).toBe(1);
  expect(home).toContain("maker/svc</a>: ");
  setSwitch(false);
  expect(await get("/?all=1", owner)).not.toContain(LINE);
});
