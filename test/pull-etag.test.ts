/** GET …/pulls/:number carries an ETag of the exact body; a repeat is 304 until the pull changes (#9142). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let stranger = "";
let number = 0;
let repoId = "";
let issueId = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const other = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
  });
  if (!other.ok) throw new Error(String(other.error));
  stranger = `forge_session=${createSession(app.db, other.value.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "private" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo.value, { title: "t", body: "", baseBranch: "main", headBranch: "topic" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  issueId = pull.value.id;
}, 120_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const get = (c: string, tag?: string) =>
  fetch(`${servers.url}/api/v1/repos/alice/r/pulls/${number}`, {
    headers: { cookie: c, ...(tag === undefined ? {} : { "if-none-match": tag }) },
  });

test("200 with a tag, 304 on a repeat, 200 with a new tag after a check verdict, 404 for a stranger", async () => {
  const first = await get(cookie);
  expect(first.status).toBe(200);
  const tag = first.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  expect(first.headers.get("vary")).toContain("authorization, cookie");
  const body = (await first.json()) as { status: { headOid: string } };

  const again = await get(cookie, tag);
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(await again.text()).toBe("");

  app.db
    .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'check', ?, ?, 'ok')")
    .run(`zzzz-${crypto.randomUUID()}`, repoId, issueId, body.status.headOid);
  const changed = await get(cookie, tag);
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(tag);
  await changed.text();

  const denied = await get(stranger, tag);
  expect(denied.status).toBe(404);
  expect(denied.headers.get("etag")).toBeNull();
});
