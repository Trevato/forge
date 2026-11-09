/** A review's words on a change's timeline sit under the verdict as plain prose, not a boxed card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { components as componentsCss } from "../src/web/style/components.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
let pullNo = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-review-lang-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const r = await createRepo(app, made.value, { name: "garden", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  await commitToBranch(app, made.value, r.value, { message: "seed", files: [{ path: "README.md", content: "# g\n" }] });
  const c = await commitToBranch(app, made.value, r.value, { branch: "one", base: "main", message: "one", files: [{ path: "one.md", content: "x\n" }] });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const o = await openPull(app, made.value, r.value, { title: "One", body: "", baseBranch: "main", headBranch: "one" });
  if (!o.ok) throw new Error(String(o.error));
  pullNo = o.value.number;
  const bob = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  const rv = (state: "approved" | "commented", body: string) => {
    const x = submitReview(app.db, { issueId: o.value.id, authorId: bob.value.id, state, body, commitOid: c.value.commitOid });
    if (!x.ok) throw new Error(x.error);
  };
  rv("approved", "**ok** <script>x</script>");
  rv("commented", "");
  servers = await serve(app);
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a review's body is prose under the verdict, escaped, outside any card", async () => {
  // the padding of .prose must not apply on the timeline
  expect(componentsCss).toMatch(/data-kind="event"\] > \.comment-body \{[^}]*padding: 0/);
  const page = await (await fetch(`${servers.url}/alice/garden/pulls/${pullNo}`)).text();
  const mine = page.indexOf("<strong>ok</strong>");
  expect(mine).toBeGreaterThan(0);
  const item = page.slice(page.lastIndexOf('data-kind="event"', mine), mine);
  expect(item).toContain('<div class="prose comment-body">');
  expect(item).not.toContain('class="card');
  expect(page).not.toContain("<script>x</script>");
  expect(page).toContain("&lt;script&gt;");
});
