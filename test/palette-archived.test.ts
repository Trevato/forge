/**
 * The palette's repository rows leave an archived repository out and bring
 * it back when it is woken; its own page still answers 200.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setArchivedIn } from "./helpers/archive.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let cookie = "";
let sleeper: Repo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-palette-archived-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-long-palette-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: "a-long-palette-passphrase" }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  for (const name of ["awake", "sleeper"]) {
    const r = await createRepo(app, made.value, { name, visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    if (name === "sleeper") sleeper = r.value;
  }
}, 30_000);

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const rows = async (): Promise<string[]> => {
  const html = await (await fetch(`${servers.url}/explore`, { headers: { cookie } })).text();
  const m = /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/.exec(html);
  if (m === null) throw new Error("no palette index");
  return (JSON.parse(m[1]!) as { items: { t: string }[] }).items.map((i) => i.t);
};

test("archived leaves the palette, waking brings it back, its page answers 200", async () => {
  expect(await rows()).toContain("alice/sleeper");
  setArchivedIn(app.db, sleeper, true);
  const away = await rows();
  expect(away).toContain("alice/awake");
  expect(away).not.toContain("alice/sleeper");
  expect((await fetch(`${servers.url}/alice/sleeper`, { headers: { cookie } })).status).toBe(200);
  setArchivedIn(app.db, sleeper, false);
  expect(await rows()).toContain("alice/sleeper");
});
