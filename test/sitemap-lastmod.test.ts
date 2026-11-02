/** /sitemap.xml gives a pushed repository a lastmod, and drops a suspended account's. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { suspendAccount } from "../src/actions/accounts.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;

const sitemap = async () => (await fetch(`${servers.url}/sitemap.xml`)).text();
const entry = (body: string, path: string) =>
  body.match(new RegExp(`<url><loc>[^<]*/${path}</loc>(.*?)</url>`))?.[1];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sitemap-lastmod-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = async (username: string, adminIfFirst: boolean) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    return u.value;
  };
  alice = await make("alice", true);
  bob = await make("bob", false);
  for (const [u, name] of [[alice, "pushed"], [alice, "empty"], [bob, "tools"]] as const) {
    const r = await createRepo(app, u, { name, visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
  }
  for (const [u, owner, name] of [[alice, "alice", "pushed"], [bob, "bob", "tools"]] as const) {
    const c = await commitToBranch(app, u, getRepo(app.db, owner, name)!, { message: "Start", files: [{ path: "README.md", content: "hi\n" }] });
    if (!c.ok) throw new Error(String(c.error));
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a pushed public repository has its lastmod as a date", async () => {
  expect(entry(await sitemap(), "alice/pushed")).toMatch(/^<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>$/);
});

test("a never-pushed repository has no lastmod", async () => {
  expect(entry(await sitemap(), "alice/empty")).toBe("");
});

test("after its owner is suspended the repository is no longer listed", async () => {
  expect(await sitemap()).toContain("/bob/tools</loc>");
  const r = await suspendAccount(app, alice, "bob");
  if (!r.ok) throw new Error(String(r.error));
  expect(await sitemap()).not.toContain("/bob/tools");
});
