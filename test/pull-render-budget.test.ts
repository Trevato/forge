/** A pull page draws its thread from remembered markdown renders: a repeat visit makes none. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment } from "../src/actions/issues.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let number = 0;
const cells = process.env["FORGE_CELLS"];

const SECTION = [
  "Looks **good** overall, with `inline code` and a [link](https://example.com/a?b=1&c=2).",
  "",
  "- first point <script>alert(1)</script>",
  "- second point with *emphasis* and #12",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "> quoted *text* with `code`",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | **2** |",
  "",
  "```js",
  "function f(a, b) { return a + b; } // add",
  "for (const k of Object.keys({})) console.log(k, \"s\", 12);",
  "```",
  "",
  "1. one",
  "2. two with [a](docs/x.md)",
].join("\n");
// An agent's comment is several of these: long, with fences, lists and a table.
const BODY = Array.from({ length: 4 }, (_, i) => `## Part ${i}\n\n${SECTION}`).join("\n\n");

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-render-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice = await mk("alice");
  const bob = await mk("bob");
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, alice, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, alice, repo.value, {
    title: "t",
    body: BODY,
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  for (let i = 0; i < 30; i++) {
    const c = addComment(app, i % 2 ? alice : bob, repo.value, pull.value, `#${i} ${BODY}`);
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
  for (const state of ["commented", "commented", "commented"] as const) {
    const r = await submitReview(app, bob, repo.value, pull.value, { state, body: BODY });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }
  for (let i = 0; i < 3; i++) {
    createRun(app.db, {
      repoId: repo.value.id,
      kind: "check",
      issueId: pull.value.id,
      env: `pull-${number}`,
      commitOid: pull.value.headOid,
    });
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a pull page serves and names its phases", async () => {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  expect(res.headers.get("server-timing") ?? "").toMatch(/render;dur=[\d.]+/);
});

test("a second visit to a busy pull renders no markdown afresh", async () => {
  const { markdownMemoStats } = await import("../src/web/markdown.ts");
  const url = `${servers.url}/alice/r/pulls/${number}`;
  await (await fetch(url, { headers: { cookie } })).arrayBuffer();
  const before = markdownMemoStats();
  const res = await fetch(url, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const after = markdownMemoStats();
  expect(after.misses).toBe(before.misses);
  expect(after.hits - before.hits).toBeGreaterThanOrEqual(30);
});

test("a repeat render of the same source returns the identical Html object", async () => {
  const { renderMarkdown } = await import("../src/web/markdown.ts");
  const first = renderMarkdown(BODY);
  expect(renderMarkdown(BODY)).toBe(first);
});

test("a remembered markdown render is the render, byte for byte, and still escapes", async () => {
  const { renderMarkdown } = await import("../src/web/markdown.ts");
  const hostile = "<img src=x onerror=alert(1)> [x](javascript:alert(1)) **b**\n\n```ts\n<b>\n```";
  const first = String(renderMarkdown(hostile));
  expect(String(renderMarkdown(hostile))).toBe(first);
  expect(first).not.toContain("<img");
  expect(first).not.toContain('href="javascript:');
  expect(first).toContain("<strong>b</strong>");
});
