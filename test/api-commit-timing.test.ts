/** The API's read of one commit names its Server-Timing phases (#3900). */
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
let oid = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-commit-timing-"));
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
    files: [{ path: "forge.json", content: "{}" }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const res = await fetch(`${servers.url}/api/v1/repos/alice/r/commits?ref=main`, { headers: { cookie } });
  oid = ((await res.json()) as { oid: string }[])[0]!.oid;
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the API read of one commit names session, git, diff, render", async () => {
  const got = await phases(`/api/v1/repos/alice/r/commits/${oid}`);
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "git", "diff", "render"]);
  expect(JSON.parse(got.body).oid).toBe(oid);
});

test("a missing repository, an unsafe rev and an unknown commit name session", async () => {
  const missing = await phases(`/api/v1/repos/alice/nope/commits/${oid}`);
  expect(missing.status).toBe(404);
  expect(missing.names).toEqual(["session"]);
  const unsafe = await phases("/api/v1/repos/alice/r/commits/--output=x");
  expect(unsafe.status).toBe(404);
  expect(unsafe.names).toEqual(["session"]);
  const unknown = await phases(`/api/v1/repos/alice/r/commits/${"0".repeat(40)}`);
  expect(unknown.status).toBe(404);
  expect(unknown.names).toEqual(["session", "git"]);
});
