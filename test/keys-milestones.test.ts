/** The milestones page joins the shell's j/k row traversal: one `data-nav` row per limb, none when empty (#10345). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let alice: User;
const limbs: number[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-milestones-keys-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  alice = u.value;
  for (const name of ["full", "empty"]) {
    const made = await createRepo(app, alice, { name });
    if (!made.ok) throw new Error(made.error);
  }
  const repo = () => getRepoById(app.db, app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='full'").get()!.id)!;
  const open = (title: string) => {
    const o = openIssue(app, alice, repo(), { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  for (const title of ["Alpha limb", "Beta limb"]) {
    const limb = open(title);
    const leaf = open(`${title} step`);
    const linked = linkIssue(app, alice, repo(), getIssueById(app.db, limb.id)!, getIssueById(app.db, leaf.id)!);
    if (!linked.ok) throw new Error(String(linked.error));
    limbs.push(limb.number);
  }
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string) =>
  (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("each limb row is a data-nav row whose first link is the milestone's own page", async () => {
  const text = await get("/alice/full/milestones");
  const rows = text.match(/<div class="row"[^>]*data-nav[^>]*>[\s\S]*?<\/div>/g) ?? [];
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.includes('tabindex="-1"'))).toBe(true);
  for (const [i, n] of limbs.entries())
    expect(rows[i]!.match(/<a [^>]*href="([^"]*)"/)?.[1]).toBe(`/alice/full/milestones/${n}`);
});

test("a page with no rows has no data-nav", async () => {
  const text = await get("/alice/empty/milestones");
  expect(text).toContain("Nothing here waits for anything yet");
  expect(text).not.toContain("data-nav");
});
