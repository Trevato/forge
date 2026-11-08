/** /resilience speaks the home page's language (#9877): one heading, the protections a plain section, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Row } from "../src/checks/resilience.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { protectionsHtml } from "../src/web/pages/resilience.ts";

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-resilience-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error("user");
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

test("an admin's /resilience: one h1, the protections a section under an h2, no card", async () => {
  const res = await fetch(`${servers.url}/resilience`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const page = main(await res.text());
  expect(page.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  expect(page).toMatch(/<section class="stack" aria-labelledby="protections-h">\s*<h2 id="protections-h">Protections<\/h2>\s*<ul class="list">/);
  expect(page).toContain('<p id="backups-line"');
});

test("a cited file the last gate did not run reads untested, never green", () => {
  const rows: Row[] = [{ p: { adversary: "Anyone", text: "A protection", test: "test/never-run.test.ts" }, s: "untested" }];
  const out = String(protectionsHtml(rows));
  expect(out).toContain('data-standing="untested"');
  expect(out).toContain(">untested<");
  expect(out).not.toContain("success");
  expect(out).not.toContain('class="card');
});
