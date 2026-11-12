/** Editing a pull, its reviews, approving it here and assigning are in the served OpenAPI document, and the refusals match the routes. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { openapi } from "../src/contract/openapi.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const R = "/api/v1/repos/{owner}/{name}";
const WANT: readonly [string, string][] = [
  ["patch", `${R}/pulls/{number}`],
  ["get", `${R}/pulls/{number}/reviews`],
  ["post", `${R}/pulls/{number}/reviews`],
  ["post", `${R}/pulls/{number}/approve-here`],
  ["put", `${R}/issues/{number}/assignee`],
  ["put", `${R}/pulls/{number}/assignee`],
];

let dir: string;
let app: App;
let http: ForgeHttp;
let token: string;
let pull: number;
let issue: number;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-openapi-pulls-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const alice = made.value;
  const repo = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const first = await commitToBranch(app, alice, repo.value, {
    message: "Start",
    files: [{ path: "README.md", content: "# lib\n" }],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  const committed = await commitToBranch(app, alice, repo.value, {
    branch: "feat",
    message: "A change",
    files: [{ path: "a.md", content: "hi\n" }],
  });
  if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  const opened = await openPull(app, alice, repo.value, { title: "Mine", baseBranch: "main", headBranch: "feat" });
  if (!opened.ok) throw new Error(String(opened.error));
  pull = opened.value.number;
  const filed = openIssue(app, alice, repo.value, { title: "An issue" });
  if (!filed.ok) throw new Error(String(filed.error));
  issue = filed.value.number;
  token = createToken(app.db, alice.id, "t", "rw").token;
  http = forgeHttp(app);
}, 120_000);

afterAll(async () => {
  http?.close();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown) =>
  http.handle(
    new Request(`http://forge.test/api/v1/repos/alice/lib${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

test("each path and method is in the document", () => {
  const paths = openapi("http://x", "1", "admin").paths as Record<string, Record<string, unknown>>;
  for (const [method, path] of WANT) expect(paths[path]?.[method]).toBeDefined();
});

test("one refusal per row is what the route answers", async () => {
  const code = async (res: Response) => ((await res.json()) as { error: string }).error;
  const patched = await call("PATCH", `/pulls/${pull}`, { state: "bogus" });
  expect([patched.status, await code(patched)]).toEqual([422, "invalid_state"]);
  const reviewed = await call("POST", `/pulls/${pull}/reviews`, { path: "nope.md", line: 1, body: "x" });
  expect([reviewed.status, await code(reviewed)]).toEqual([422, "bad_anchor"]);
  const approved = await call("POST", `/pulls/${pull}/approve-here`);
  expect(await code(approved)).toBe("not_foreign");
  for (const [kind, number] of [["issues", issue], ["pulls", pull]] as const) {
    const assigned = await call("PUT", `/${kind}/${number}/assignee`, { assignee: "nobody-here" });
    expect([assigned.status, await code(assigned)]).toEqual([422, "no_such_user"]);
  }
  expect((await call("GET", `/pulls/${pull}/reviews`)).status).toBe(200);
});
