/** `/:owner/:name/pulls/:n/resolve`'s Server-Timing names its phases (#3463). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
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
let number = 0;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-conflicts-timing-"));
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
  const commit = async (branch: string | undefined, content: string) => {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: "a.txt", content }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  };
  await commit(undefined, "one\n");
  await commit("topic", "theirs\n");
  await commit(undefined, "ours\n");
  const pull = await openPull(app, alice, repo.value, {
    title: "t",
    body: "",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a conflicted pull's resolve page names its phases after app, in order", async () => {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}/resolve`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Block 1 of 1");
  const parts = requestTiming(res).split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  expect(names.slice(names.indexOf("app") + 1)).toEqual([
    "session", "pull", "checkout", "status", "file", "crew", "render",
  ]);
  for (const p of parts) expect(p).toMatch(/;dur=\d+\.\d/);
});
