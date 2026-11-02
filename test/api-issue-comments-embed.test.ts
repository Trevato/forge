/** An issue read embeds its newest 50 comments and a cursor for the rest (#6198). */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-commentsembed-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const issue = createIssue(app.db, { repoId: made.value.id, title: "long", body: "b", authorId: admin.value.id });
  if (!issue.ok) throw new Error(String(issue.error));
  number = issue.value.number;
  for (let i = 1; i <= 300; i++)
    addComment(app.db, { issueId: issue.value.id, authorId: admin.value.id, body: `c${i} ${"x".repeat(1500)}` });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

type C = { id: string; body: string };
const base = () => `${servers.url}/api/v1/repos/alice/notes/issues/${number}`;
const n = (c: C) => Number(c.body.slice(1).split(" ")[0]);

test("300 comments: 50 embedded under 100 KB, and the cursor walks back to the first", async () => {
  const res = await fetch(base());
  const text = await res.text();
  expect(text.length).toBeLessThan(100_000);
  const body = JSON.parse(text) as { comments: C[]; commentsTotal: number; commentsNext: string | null };
  expect(body.comments.length).toBe(50);
  expect(body.commentsTotal).toBe(300);
  expect(body.comments.map(n)).toEqual(Array.from({ length: 50 }, (_, i) => 251 + i));
  let cursor = body.commentsNext;
  const seen = [...body.comments];
  let pages = 0;
  while (cursor !== null && pages < 10) {
    const page = (await (await fetch(`${base()}/comments?cursor=${cursor}`)).json()) as { comments: C[]; next: string | null };
    expect(page.comments.length).toBe(50);
    seen.unshift(...page.comments);
    cursor = page.next;
    pages++;
  }
  expect(pages).toBe(5);
  expect(seen.map(n)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
});

test("a bad cursor is a 422, and cursor with after is refused", async () => {
  expect((await fetch(`${base()}/comments?cursor=a%20b`)).status).toBe(422);
  expect((await fetch(`${base()}/comments?cursor=x&after=y`)).status).toBe(422);
});
