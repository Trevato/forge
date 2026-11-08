/** A forge preview's check reports the held page as an owner look, desktop and phone, with screens tall (#9508). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { PREVIEW_HELD_PAGE, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { looksPath } from "../src/checks/looks.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";
const cells = process.env["FORGE_CELLS"];
const OID = "b".repeat(40);

const get = async (path: string) => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  return (await res.json()) as any;
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-check-looks-api-"));
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
  repoId = repo.value.id;
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const lookName = (page: string, kind: string) => (page === "/" ? kind : `${kind} ${page}`);

test("a forge preview's check lists the held page at desktop and phone with screens tall", async () => {
  const held = PREVIEW_OWNER_LOOKS.filter((l) => l.page === PREVIEW_HELD_PAGE);
  expect(held.map((l) => l.kind).sort()).toEqual(["desktop", "phone"]);
  const run = createRun(app.db, { repoId, kind: "check", commitOid: OID, env: "main", branch: "main" });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "ok" });
  const path = looksPath(dataDir, run.id);
  mkdirSync(join(path, ".."), { recursive: true });
  const size = { scrollWidth: 390, scrollHeight: 2000, innerWidth: 390, innerHeight: 800 };
  writeFileSync(
    path,
    JSON.stringify(
      PREVIEW_OWNER_LOOKS.map((l) => ({ look: lookName(l.page, l.kind), entries: {}, size })),
    ),
  );
  const body = await get(`/api/v1/repos/alice/r/commits/${OID}/check`);
  for (const kind of ["desktop", "phone"]) {
    expect(body.looks).toContainEqual({
      look: `${kind} ${PREVIEW_HELD_PAGE}`,
      screens: "2.5",
      sideways: false,
    });
  }
});
