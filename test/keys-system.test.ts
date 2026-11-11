/** /system's feature rows join j/k traversal (#10340): one `data-nav` per row, linking to the app's own page; none when empty. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { absorb } from "../src/core/features.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let token = "";
let ada: Awaited<ReturnType<typeof createUser>> & { ok: true };

const get = async () => (await fetch(`${servers.url}/system`, { headers: { authorization: `Bearer ${token}` } })).text();
const navs = (html: string) => html.match(/<a [^>]*data-nav[^>]*>/g) ?? [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-keys-system-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  ada = r as typeof ada;
  token = createToken(app.db, r.value.id, "t", "admin").token;
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a page with no features has no data-nav", async () => {
  expect(await get()).not.toContain("data-nav");
});

test("each feature row is one data-nav linking to its own page", async () => {
  for (const name of ["one", "two"]) {
    const repo = await createRepo(app, ada.value, { name, visibility: "public", description: "" });
    if (!repo.ok) throw new Error(String(repo.error));
    const a = insertApp(app.db, { repoId: repo.value.id, slug: name, access: "public" });
    if (!a.ok) throw new Error(a.error);
    absorb(app.db, a.value.id, ada.value.id, name, "/");
  }
  const found = navs(await get());
  expect(found).toHaveLength(2);
  expect(found.some((a) => a.includes('href="/ada/one"'))).toBe(true);
  expect(found.some((a) => a.includes('href="/ada/two"'))).toBe(true);
  expect(found.every((a) => a.includes('tabindex="-1"'))).toBe(true);
});
