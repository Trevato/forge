/** The origins page joins the shell's j/k row traversal (#10542): only the frozen-mirror rows are data-nav. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { createOrigin } from "../src/core/origins.ts";
import { createRepo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;
let cookie = "";
let ownerId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-origins-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!a.ok) throw new Error(a.error);
  const alice = getUserByName(app.db, "alice")!;
  ownerId = alice.id;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  createOrigin(app.db, dataDir, {
    userId: alice.id, kind: "forgejo", apiUrl: "https://codeberg.org/api/v1",
    webUrl: "https://codeberg.org", login: "alice-cb", token: "tok",
  });
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async () => (await fetch(`${servers.url}/settings/origins`, { headers: { cookie } })).text();
const NAV = /class="row"[^>]*data-nav tabindex="-1"/;
const frozenSection = (t: string) => {
  const at = t.indexOf("<h2>Frozen mirrors</h2>");
  return at < 0 ? "" : t.slice(at, t.indexOf("</section>", at));
};

test("no frozen mirrors: no section and no origin-card data-nav row", async () => {
  const text = await get();
  expect(text).toContain("alice-cb");
  expect(frozenSection(text)).toBe("");
  const main = text.slice(text.indexOf("<main"), text.indexOf("</main>"));
  expect(main).not.toMatch(NAV);
});

test("each frozen mirror is one data-nav row; the origin card has none", async () => {
  for (const name of ["one", "two"]) {
    const made = await createRepo(app.db, join(dataDir, "repos"), { ownerId, name, visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    app.db.query(
      "UPDATE repo SET origin_full_name = ?2, origin_html_url = ?3, origin_detached_at = '2026-10-11T00:00:00.000Z' WHERE id = ?1",
    ).run(made.value.id, `octo/${name}`, `https://codeberg.org/octo/${name}`);
  }
  const text = await get();
  const section = frozenSection(text);
  expect(section).toContain("octo/one");
  const rows = section.split("<li").filter((li) => NAV.test(li));
  expect(rows.length).toBe(2);
  expect(rows[0]).toContain('href="/alice/one#frozen"');
  expect(rows[1]).toContain('href="/alice/two#frozen"');
  const main = text.slice(text.indexOf("<main"), text.indexOf("</main>"));
  expect(main.split("<li").filter((li) => NAV.test(li)).length).toBe(2);
});
