/**
 * The issues comment route answers for a pull's number too, as the OpenAPI
 * document says (#3298): the comment lands on the pull, through the same path
 * as `…/pulls/{number}/comments`; a number that is neither stays not_found.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssue, listComments } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";
let pullNumber = 0;
let repoId = "";

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const comment = (number: number, text: string, auth = token) =>
  fetch(`${servers.url}/api/v1/repos/alice/sq/issues/${number}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ body: text }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-issue-pull-comment-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const alice = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  const repo = ok(await createRepo(app, alice, { name: "sq", visibility: "public" }));
  repoId = repo.id;
  ok(
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# sq\n" }],
    }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      branch: "topic",
      base: "main",
      message: "Topic",
      files: [{ path: "README.md", content: "# sq\nmore\n" }],
    }),
  );
  const pull = ok(
    await openPull(app, alice, repo, {
      title: "Topic",
      body: "",
      baseBranch: "main",
      headBranch: "topic",
    }),
  );
  pullNumber = pull.number;
  token = createToken(app.db, alice.id, "rw", "rw").token;
});

afterAll(async () => {
  await servers.stop();
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("commenting through the issues route on a pull's number comments on the pull", async () => {
  const res = await comment(pullNumber, "Seen from the issues route.");
  expect(res.status).toBe(201);
  const pull = getIssue(app.db, repoId, pullNumber);
  expect(listComments(app.db, pull!.id).map((c) => c.body)).toContain(
    "Seen from the issues route.",
  );
});

test("a number that is neither an issue nor a pull stays not_found", async () => {
  expect((await comment(999, "nobody home")).status).toBe(404);
});

test("a read-only token is still refused on a pull's number", async () => {
  const ro = createToken(app.db, getIssue(app.db, repoId, pullNumber)!.authorId, "ro", "ro");
  expect((await comment(pullNumber, "no", ro.token)).status).toBe(403);
});
