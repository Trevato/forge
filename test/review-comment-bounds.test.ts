/**
 * The bounds on what one review or comment may carry: more than
 * MAX_REVIEW_LINES line comments is refused whole, exactly that many lands,
 * and a comment of nothing but whitespace is refused over the API and the
 * MCP alike. A refusal writes nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { MAX_REVIEW_LINES, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listComments } from "../src/core/issues.ts";
import { listReviewComments, listReviews } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";
let pull: { id: string; number: number };
let nextId = 1;

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const post = (path: string, payload: unknown) =>
  fetch(`${servers.url}/api/v1/repos/alice/bounds/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: "big.txt",
    line: i + 1,
    side: "new",
    body: `note ${i + 1}`,
  }));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-review-bounds-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) =>
    ok(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      }),
    );
  const alice = await mk("alice", true);
  const bob = await mk("bob");
  promote(app.db, alice, bob);
  token = createToken(app.db, alice.id, "rw", "rw").token;
  const repo = ok(
    await createRepo(app, alice, { name: "bounds", visibility: "public" }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# bounds\n" }],
    }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      branch: "topic",
      base: "main",
      message: "Many lines",
      files: [
        {
          path: "big.txt",
          content: Array.from({ length: 60 }, (_, i) => `row ${i + 1}\n`).join(""),
        },
      ],
    }),
  );
  const opened = ok(
    await openPull(app, alice, repo, {
      title: "Many lines",
      body: "",
      baseBranch: "main",
      headBranch: "topic",
    }),
  );
  pull = { id: opened.id, number: opened.number };
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a review with more than the cap of line comments is refused and nothing is stored", async () => {
  const res = await post(`pulls/${pull.number}/review-states`, {
    state: "commented",
    comments: lines(MAX_REVIEW_LINES + 1),
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { error: string }).error).toBe(
    "too_many_lines",
  );
  expect(listReviews(app.db, pull.id)).toEqual([]);
  expect(listReviewComments(app.db, pull.id)).toEqual([]);
});

test("exactly the cap of line comments lands", async () => {
  const res = await post(`pulls/${pull.number}/review-states`, {
    state: "commented",
    comments: lines(MAX_REVIEW_LINES),
  });
  expect(res.status).toBe(201);
  expect(listReviews(app.db, pull.id)).toHaveLength(1);
  expect(listReviewComments(app.db, pull.id)).toHaveLength(MAX_REVIEW_LINES);
});

test("a comment of spaces and newlines is refused over the API and the MCP, and the thread is unchanged", async () => {
  const before = listComments(app.db, pull.id).length;
  const blank = " \n\t  \n ";
  const api = await post(`issues/${pull.number}/comments`, { body: blank });
  expect(api.status).toBe(422);
  expect(((await api.json()) as { error: string }).error).toBe("empty_body");
  const onPull = await post(`pulls/${pull.number}/comments`, { body: blank });
  expect(onPull.status).toBe(422);

  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "say",
        arguments: { repo: "alice/bounds", number: pull.number, text: blank },
      },
    }),
  });
  const body = (await res.json()) as any;
  expect(body.result.isError).toBe(true);
  expect(listComments(app.db, pull.id)).toHaveLength(before);
});
