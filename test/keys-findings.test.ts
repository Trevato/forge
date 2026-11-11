/** The findings page joins the shell's j/k row traversal (#10344): one data-nav per row, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { secretFindings } from "../src/checks/scan_rules.ts";
import { recordFindings } from "../src/checks/scan_store.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-findings-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const full = await createRepo(app, made.value, { name: "full", visibility: "public" });
  const bare = await createRepo(app, made.value, { name: "bare", visibility: "public" });
  if (!full.ok || !bare.ok) throw new Error("repo");
  recordFindings(app.db, full.value.id, "a".repeat(40), [
    ...secretFindings("deploy.ts", `const k = "${AWS}";\n`),
    ...secretFindings("src/env.ts", `\n\nconst k = "${AWS}x";\n`),
  ]);
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("each finding row is one data-nav link to its file", async () => {
  const text = await (await fetch(`${servers.url}/alice/full/findings`)).text();
  const navs = [...text.matchAll(/<a href="([^"]+)"\s+class="row"[^>]*data-nav tabindex="-1"/g)].map((m) => m[1]);
  expect(navs.length).toBeGreaterThan(0);
  expect(text.match(/data-nav/g)!.length).toBe(navs.length);
  for (const n of navs) expect(n).toMatch(/^\/alice\/full\/blob\/a{40}\/[\w./-]+#L\d+$/);
});

test("the empty page draws no data-nav", async () => {
  const res = await fetch(`${servers.url}/alice/bare/findings`);
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain("data-nav");
});
