/** The look under a pull's checks speaks the home page's language: a block under an h2, not a card; pictures still need read access. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const HEAD = "c".repeat(40);
let dataDir = "";
let app: App, servers: Servers;
let publicPull = 0, privatePull = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-looks-lang-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const setup = async (name: string, visibility: "public" | "private") => {
    const r = await createRepo(app, made.value, { name, visibility });
    if (!r.ok) throw new Error(String(r.error));
    await commitToBranch(app, made.value, r.value, { message: "seed", files: [{ path: "README.md", content: "# g\n" }] });
    await commitToBranch(app, made.value, r.value, { branch: "one", base: "main", message: "one", files: [{ path: "one.md", content: "x\n" }] });
    const o = await openPull(app, made.value, r.value, { title: "One", body: "", baseBranch: "main", headBranch: "one" });
    if (!o.ok) throw new Error(String(o.error));
    const a = insertApp(app.db, { repoId: r.value.id, slug: name, access: visibility === "public" ? "public" : "private" });
    if (!a.ok) throw new Error(a.error);
    recordLook(app.db, {
      appId: a.value.id, env: previewEnv(o.value.number), commitOid: HEAD,
      path: "looks/x.png", takenAs: "nobody", kind: "phone", theme: "light",
    });
    return o.value.number;
  };
  publicPull = await setup("garden", "public");
  privatePull = await setup("vault", "private");
  servers = await serve(app);
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

test("the look on a pull is a block under an h2, no card, pictures intact", async () => {
  const m = main(await (await fetch(`${servers.url}/alice/garden/pulls/${publicPull}`)).text());
  expect(m).toMatch(/<section class="settings-block" id="look"[^>]*>\s*<h2>Look<\/h2>/);
  const look = m.slice(m.indexOf('id="look"'));
  expect(look).toContain(`/${HEAD}/phone.png`);
  expect(look).toContain('data-slot="phone"');
  expect(look.slice(0, look.indexOf("</section>"))).not.toContain('class="card');
});

test("a private repository's picture is a 404 to an outsider, and its pull page too", async () => {
  const url = `${servers.url}/alice/vault/looks/${previewEnv(privatePull)}/${HEAD}/phone.png`;
  expect((await fetch(url)).status).toBe(404);
  const page = await fetch(`${servers.url}/alice/vault/pulls/${privatePull}`);
  expect(page.status).toBe(404);
});
