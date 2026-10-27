/** MCP `issue` embeds the newest 50 comments, the total and a cursor the API honours (#6198). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addComment, createIssue, EMBEDDED_COMMENTS } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers;
let token = "";
let number = 0;
const SEEDED = 120;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-issue-comments-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  token = createToken(app.db, admin.value.id, "rw", "rw").token;
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const issue = createIssue(app.db, { repoId: made.value.id, title: "long", body: "b", authorId: admin.value.id });
  if (!issue.ok) throw new Error(String(issue.error));
  number = issue.value.number;
  for (let i = 1; i <= SEEDED; i++)
    addComment(app.db, { issueId: issue.value.id, authorId: admin.value.id, body: `c${i}` });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("issue answers the newest 50 oldest first, the total, and a working cursor", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "issue", arguments: { repo: "alice/notes", number } },
    }),
  });
  const out: any = await res.json();
  expect(out.result.isError).not.toBe(true);
  const issue = JSON.parse(out.result.content[0].text) as {
    comments: { body: string }[];
    commentsTotal: number;
    commentsNext: string | null;
  };
  expect(issue.comments.length).toBe(EMBEDDED_COMMENTS);
  expect(issue.comments[0]!.body).toBe(`c${SEEDED - EMBEDDED_COMMENTS + 1}`);
  expect(issue.comments.at(-1)!.body).toBe(`c${SEEDED}`);
  expect(issue.commentsTotal).toBe(SEEDED);
  // The cursor is the first embedded comment's id: the API's page before it ends just under it.
  const first = (await (await fetch(`${servers.url}/api/v1/repos/alice/notes/issues/${number}`)).json()) as {
    comments: { id: string }[];
  };
  expect(issue.commentsNext).toBe(first.comments[0]!.id);
  const page = (await (
    await fetch(`${servers.url}/api/v1/repos/alice/notes/issues/${number}/comments?cursor=${issue.commentsNext}`)
  ).json()) as { comments: { body: string }[]; next: string | null };
  expect(page.comments.at(-1)!.body).toBe(`c${SEEDED - EMBEDDED_COMMENTS}`);
  expect(page.comments[0]!.body).toBe("c21");
  expect(page.comments.length).toBe(50);
});
