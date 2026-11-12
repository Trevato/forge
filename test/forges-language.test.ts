/** /forges, its fresh-link page and the remove confirm speak the home page's language (#9798): headings, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let auth: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-forges-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  auth = { authorization: `Bearer ${createToken(app.db, made.value.id, "t", "admin").token}` };
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const boxed = ['class="card', "card-body", 'class="empty'];

test("with none sent, /forges is a headed section, not an empty-state box", async () => {
  const page = main(await (await fetch(servers.url + "/forges", { headers: auth })).text());
  expect(page).toContain('<section class="settings-block">');
  expect(page).toContain("<h2>No forges sent yet</h2>");
  for (const b of boxed) expect(page).not.toContain(b);
});

test("with one sent, /forges has its headings over the table and the rows", async () => {
  mkdirSync(join(dir, "spawn"), { recursive: true });
  writeFileSync(join(dir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "b-k", done: true, size: "small" }));
  const res = await fetch(servers.url + "/forges", { headers: auth });
  const page = main(await res.text());
  expect(page).toContain("<h2>Side by side</h2>");
  expect(page).toContain("<h2>Forges</h2>");
  expect(page).toContain('id="forges-compare"');
  expect(page).toContain('data-forge="kid"');
  for (const b of boxed) expect(page).not.toContain(b);
});

test("the remove confirm keeps its words and buttons under a heading, not in a card", async () => {
  const res = await fetch(servers.url + "/forges/kid/remove", { headers: auth });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const page = main(await res.text());
  expect(page).toContain("<h2>What removing deletes</h2>");
  expect(page).toContain("It cannot be undone.");
  expect(page).toContain("Remove it for good");
  expect(page).toContain("Keep it");
  for (const b of boxed) expect(page).not.toContain(b);
});
