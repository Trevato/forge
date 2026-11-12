/** A real open pull sets its issue's state word on /next (#11619): building, then checking, then in review. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
let issue: number;
let pullId: string;
let head: string;
let repoId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-next-pull-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "wip", visibility: "public" });
  if (!repo.ok) throw new Error(JSON.stringify(repo.error));
  repoId = repo.value.id;
  const opened = openIssue(app, alice, repo.value, { title: "Build the thing" });
  if (!opened.ok) throw new Error(String(opened.error));
  issue = opened.value.number;
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, { ...(branch === undefined ? {} : { branch }), message: "change", files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }] });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo.value, { title: "Build it", body: `Closes #${issue}`, baseBranch: "main", headBranch: "topic" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  const row = app.db.query<{ id: string; head_oid: string }, [number]>("SELECT issue.id, pull.head_oid FROM issue JOIN pull ON pull.issue_id = issue.id WHERE issue.number = ?1").get(pull.value.number)!;
  pullId = row.id;
  head = row.head_oid;
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const rowOf = async (): Promise<string> => {
  const page = await (await fetch(`${servers.url}/alice/wip/next`, { headers: { cookie } })).text();
  return page.split("<li").find((li) => li.includes(`data-number="${issue}"`))!.replace(/\s+/g, " ");
};
const check = (id: string, state: string) =>
  app.db.query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'check', ?, ?, ?)").run(id, repoId, pullId, head, state);

test("an open pull that closes the issue reads building, checking, then in review", async () => {
  expect(await rowOf()).toContain("building");
  check("zz-run-1", "running");
  expect(await rowOf()).toContain("checking");
  app.db.query("UPDATE run SET state = 'ok' WHERE id = 'zz-run-1'").run();
  app.db.query("UPDATE repo SET require_review = 1 WHERE id = ?").run(repoId);
  expect(await rowOf()).toContain("in review");
});
