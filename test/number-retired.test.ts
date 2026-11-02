/** An issue's or pull's number in a heading draws from base's `.num`; `.number` left the stylesheet (#5253). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { changeHead } from "../src/web/studio/change.ts";
import { css } from "../src/web/style";

let dataDir: string;
let app: App;
let servers: Servers;
let base: string;
let repo: Repo;
let opened: Issue;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-num-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  const user = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "n",
    email: "n@f.dev",
    password: "numbers-please",
  });
  if (!user.ok) throw new Error("user");
  const made = await createRepo(app.db, app.reposRoot, { ownerId: user.value.id, name: "r", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  repo = made.value;
  for (const kind of ["issue", "pull"] as const) {
    const made = createIssue(app.db, { repoId: repo.id, authorId: user.value.id, title: `a ${kind}`, kind });
    if (!made.ok) throw new Error(kind);
    opened = made.value;
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the stylesheet no longer contains .number", () => {
  expect(css).not.toMatch(/\.number\b/);
});

test("the issue heading marks its number with .num", async () => {
  const page = await (await fetch(`${base}/n/r/issues/1`)).text();
  expect(page).toMatch(/<h1>a issue\s*<span class="num">#1<\/span><\/h1>/);
  expect(page).not.toContain('class="number"');
});

test("the pull heading marks its number with .num", () => {
  const pull: Pull = {
    ...opened,
    baseBranch: "main",
    headBranch: "change",
    baseOid: "",
    headOid: "",
    mergedAt: null,
    mergedOid: null,
    headRepoId: repo.id,
    crossRepo: false,
    originHeadRepo: null,
    revertsPullId: null,
    variantGroup: null,
  };
  const head = String(changeHead({ app, auth: { user: undefined, scope: undefined, via: "none" } } as Ctx, repo, pull));
  expect(head).toContain('<h1>a pull <span class="num">#2</span></h1>');
  expect(head).not.toContain('class="number"');
});
