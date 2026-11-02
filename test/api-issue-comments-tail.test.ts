/** GET …/issues/{number}?comments=N answers the newest N comments and the total (#4097). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addComment, createIssue } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;
let number = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-commentstail-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const issue = createIssue(app.db, { repoId: made.value.id, title: "long", body: "b", authorId: admin.value.id });
  if (!issue.ok) throw new Error(String(issue.error));
  number = issue.value.number;
  for (let i = 1; i <= 30; i++)
    addComment(app.db, { issueId: issue.value.id, authorId: admin.value.id, body: `c${i}` });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const read = (q: string) => fetch(`${servers.url}/api/v1/repos/alice/notes/issues/${number}${q}`);
type Body = {
  comments: { id: string; body: string }[];
  commentCount?: number;
  commentsTotal: number;
  commentsNext: string | null;
};

test("comments=5 answers the newest five, oldest first, with the total", async () => {
  const res = await read("?comments=5");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Body;
  expect(body.comments.map((c) => c.body)).toEqual(["c26", "c27", "c28", "c29", "c30"]);
  expect(body.commentCount).toBe(30);
});

test("comments=0 answers no comments and the count", async () => {
  const body = (await (await read("?comments=0")).json()) as Body;
  expect(body.comments).toEqual([]);
  expect(body.commentCount).toBe(30);
});

test("comments=200 on a shorter thread answers all of it", async () => {
  const body = (await (await read("?comments=200")).json()) as Body;
  expect(body.comments.length).toBe(30);
  expect(body.commentCount).toBe(30);
});

test("anything but 0 to 200 is a 422 invalid_comments", async () => {
  for (const q of ["abc", "201", "-1", "1.5", ""]) {
    const res = await read(`?comments=${q}`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_comments");
  }
});

test("without the parameter the newest 50 come back with the total and no commentCount", async () => {
  const body = (await (await read("")).json()) as Body;
  expect(body.comments.length).toBe(30);
  expect("commentCount" in body).toBe(false);
  expect(body.commentsTotal).toBe(30);
  expect(body.commentsNext).toBeNull();
});

test("comments=5 hands a cursor to the older ones; comments=0 hands none", async () => {
  const some = (await (await read("?comments=5")).json()) as Body;
  expect(some.commentsNext).toBe(some.comments[0]!.id);
  const none = (await (await read("?comments=0")).json()) as Body;
  expect(none.commentsNext).toBeNull();
});
