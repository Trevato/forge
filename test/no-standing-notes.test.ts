/** DESIGN.md rule 2 (#10688): the standing explanations on five pages stay gone; the actions stay. Rendered, not grepped. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let bearer = "";
const get = async (path: string) =>
  (await fetch(servers.url + path, { headers: { authorization: `Bearer ${bearer}` } })).text();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-no-notes-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  bearer = createToken(app.db, made.value.id, "t", "admin").token;
  await fetch(servers.url + "/api/v1/repos", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "zephyr", visibility: "public" }),
  });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const gone: [string, string][] = [
  ["/search", "Search this forge:"],
  ["/alice/zephyr/settings/machines", "A machine is where the crew shell runs"],
  ["/settings/crew", "An agent is an account that works"],
  ["/forges/new", "A whole forge for someone:"],
  ["/pinned", "on one version that changes only"],
];

for (const [path, sentence] of gone) {
  test(`${path} renders without its standing explanation`, async () => {
    const html = await get(path);
    expect(html).toContain("<main");
    expect(html).not.toContain("<h1>404</h1>");
    expect(html).not.toContain(sentence);
  });
}

test("search shows the short placeholder", async () => {
  expect(await get("/search")).toContain('placeholder="Apps, repos, issues, pulls, code"');
});

test("pinned keeps its action", async () => {
  expect(await get("/pinned")).toContain('href="/deploy-to"');
});

test("an empty crew says what to do in one clause", async () => {
  const html = await get("/settings/crew");
  expect(html).toContain("No agents yet");
  expect(html).toContain("Make one below.");
});
