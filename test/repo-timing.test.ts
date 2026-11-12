/** A repository home's Server-Timing names its phases, in order (#3325). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-repo-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const done = await commitToBranch(app, alice, repo.value, {
    message: "change",
    files: [{ path: "README.md", content: "# hi" }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a repository home names session, appof, refs, tree, readme, following, wave, credit, behind and render in order", async () => {
  const res = await fetch(`${servers.url}/alice/r`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  expect(names).toEqual(["app", "session", "appof", "refs", "tree", "readme", "following", "wave", "credit", "behind", "render"]);
});
