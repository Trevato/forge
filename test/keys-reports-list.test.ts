/** The reports list joins the shell's j/k row traversal (#10355): one data-nav per row, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { fileReport } from "../src/actions/reports.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-reports-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const full = await createRepo(app, made.value, { name: "full", visibility: "public" });
  const bare = await createRepo(app, made.value, { name: "bare", visibility: "public" });
  if (!full.ok || !bare.ok) throw new Error("repo");
  for (const [i, title] of ["First", "Second", "Third"].entries()) {
    const filed = fileReport(app, full.value, { title, body: "", page: "" }, `src-${i}`);
    if (!filed.ok) throw new Error(JSON.stringify(filed.error));
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${servers.url}${path}`, { headers: { cookie } });

test("each report row is one data-nav summary, no nested data-nav", async () => {
  const text = await (await get("/alice/full/reports")).text();
  const navs = [...text.matchAll(/<summary[^>]*data-nav tabindex="-1"/g)];
  expect(navs.length).toBe(3);
  expect(text.match(/data-nav/g)!.length).toBe(3);
  expect(text.match(/<details id="report-/g)!.length).toBe(3);
});

test("the empty list draws no data-nav", async () => {
  const res = await get("/alice/bare/reports");
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain("data-nav");
});
