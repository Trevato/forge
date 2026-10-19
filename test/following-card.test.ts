/**
 * The "following" card on a fork's page is built by card() (#2891): one
 * `div.card.following#following` with its badge and sentence, not hand-rolled
 * markup.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-following-card-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const alice = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!alice.ok) throw new Error(alice.error);
  const lib = await createRepo(app, alice.value, { name: "lib", visibility: "public" });
  if (!lib.ok) throw new Error(String(lib.error));
  const seeded = await commitToBranch(app, alice.value, lib.value, {
    message: "Start",
    files: [{ path: "README.md", content: "# lib\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  promote(app.db, bob.value);
  const forked = await forkRepo(app, bob.value, lib.value);
  if (!forked.ok) throw new Error(String(forked.error));
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a fork's page has the following card, built by card()", async () => {
  const path = "/bob/lib";
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie: "forge_mode=dev" } });
  const page = await res.text();
  const m = page.match(/<div\s+class="card following"\s+id="following"[^>]*>[\s\S]*?<div class="card-body">([\s\S]*?)<\/div>\s*<\/div>/);
  expect(page).not.toContain("<section class=\"card following\"");
  expect(m).not.toBeNull();
  expect(m![0]).toContain("following-eyebrow");
  expect(m![0]).toContain('class="badge');
  expect(m![0]).toContain("following-sentence");
}, 30_000);
