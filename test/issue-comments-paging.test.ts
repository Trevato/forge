/** GET …/issues/{number}/comments pages a thread: {comments, next} (#4150). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";
let issueNumber = 0;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const get = (repo: string, number: number, query = "", auth?: string) =>
  fetch(`${servers.url}/api/v1/repos/alice/${repo}/issues/${number}/comments${query}`, {
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-comment-paging-"));
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
  const repo = ok(await createRepo(app, alice, { name: "pub", visibility: "public" }));
  const issue = ok(await openIssue(app, alice, repo, { title: "Long", body: "" }));
  issueNumber = issue.number;
  for (let i = 0; i < 120; i++) ok(await addComment(app, alice, repo, issue, `c${i}`));
  const secret = ok(await createRepo(app, alice, { name: "priv", visibility: "private" }));
  ok(await openIssue(app, alice, secret, { title: "Hidden", body: "" }));
  token = createToken(app.db, alice.id, "rw", "rw").token;
});

afterAll(async () => {
  await servers.stop();
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("120 comments page in three calls, each once, in order", async () => {
  const seen: string[] = [];
  let after = "";
  const sizes: number[] = [];
  for (let calls = 0; calls < 5; calls++) {
    const res = await get("pub", issueNumber, `?limit=50${after}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { comments: { id: string; body: string }[]; next: string | null };
    sizes.push(page.comments.length);
    seen.push(...page.comments.map((c) => c.body));
    if (page.next === null) break;
    after = `&after=${page.next}`;
  }
  expect(sizes).toEqual([50, 50, 20]);
  expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `c${i}`));
});

test("the default page is 50", async () => {
  const page = (await (await get("pub", issueNumber)).json()) as { comments: unknown[]; next: string };
  expect(page.comments.length).toBe(50);
  expect(page.next).toBeTruthy();
});

test("bad limit or after is a 422", async () => {
  for (const q of ["?limit=0", "?limit=101", "?limit=x", "?limit=-1", "?after=a%20b"])
    expect((await get("pub", issueNumber, q)).status).toBe(422);
});

test("a private repository is not found to a stranger", async () => {
  expect((await get("priv", 1)).status).toBe(404);
  expect((await get("priv", 1, "", token)).status).toBe(200);
});

test("a number that is not there is not found", async () => {
  expect((await get("pub", 999)).status).toBe(404);
});
