/**
 * An open pull is always on the Pulls page (#10293): a pull whose check was
 * stopped is listed with its word, and the page's rows equal the open count.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun, finishRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pulls-open-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const repo = await createRepo(app, made.value, { name: "lib", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const pull = (title: string, head: string) => {
    const p = createIssue(app.db, { repoId: repo.value.id, authorId: made.value.id, title, kind: "pull" });
    if (!p.ok) throw new Error(String(p.error));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
              VALUES (?1, 'main', ?2, 'a', ?3, ?4)`)
      .run(p.value.id, head, head, repo.value.id);
    return p.value;
  };
  pull("Quiet one", "b".repeat(40));
  const stopped = pull("Stopped one", "c".repeat(40));
  const run = createRun(app.db, {
    repoId: repo.value.id, kind: "check", issueId: stopped.id, commitOid: "c".repeat(40),
  });
  app.db.query("UPDATE run SET state = 'running' WHERE id = ?1").run(run.id);
  finishRun(app.db, run.id, { state: "failed", summary: "bun test failed" });
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("a pull stopped on a failed check is listed, and rows equal the open count", async () => {
  const res = await fetch(`${servers.url}/alice/lib/pulls`, { headers: { cookie } });
  const text = await res.text();
  expect(text).toContain("Stopped one");
  expect(text).toContain("Quiet one");
  const open = app.db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue WHERE kind = 'pull' AND state = 'open'")
    .get()!.n;
  expect(open).toBe(2);
  const rows = (text.match(/href="\/alice\/lib\/pulls\/\d+" class="row"/g) ?? []).length;
  expect(rows).toBe(open);
  const stoppedRow = text.slice(text.indexOf("Stopped one"), text.indexOf("</li>", text.indexOf("Stopped one")));
  expect(stoppedRow).toContain("Its check is red.");
});
