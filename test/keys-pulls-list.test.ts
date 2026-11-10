/** The pulls list joins the shell's j/k row traversal (#10337): one data-nav per row, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
const numbers: number[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-pulls-"));
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
  for (const [i, title] of ["First", "Second", "Third"].entries()) {
    const p = createIssue(app.db, { repoId: full.value.id, authorId: made.value.id, title, kind: "pull" });
    if (!p.ok) throw new Error(String(p.error));
    const head = String(i + 1).repeat(40);
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
              VALUES (?1, 'main', ?2, 'a', ?3, ?4)`)
      .run(p.value.id, `b${i}`, head, full.value.id);
    numbers.push(p.value.number);
  }
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("each pull row is one data-nav link to its own page", async () => {
  const text = await (await fetch(`${servers.url}/alice/full/pulls`)).text();
  const navs = [...text.matchAll(/<a href="([^"]+)"\s+class="row"[^>]*data-nav tabindex="-1"/g)].map((m) => m[1]);
  expect(navs.length).toBe(3);
  expect(text.match(/data-nav/g)!.length).toBe(3);
  for (const n of numbers) expect(navs).toContain(`/alice/full/pulls/${n}`);
});

test("the empty list draws no data-nav", async () => {
  const res = await fetch(`${servers.url}/alice/bare/pulls`);
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain("data-nav");
});
