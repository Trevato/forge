/**
 * Every main page has a first-view budget (#10297): visible words, text
 * blocks and distinct colours, at 390 px and 1280 px, in
 * docs/design/attention-budget.json. A page over its budget fails. A pass may
 * lower a budget (run with FORGE_ATTENTION_WRITE=1 to rewrite the file);
 * nothing may raise one without a note in the pull.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createRun } from "../src/core/runs.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstView, WIDTHS, type Attention } from "../src/measure/attention.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const BUDGET = "docs/design/attention-budget.json";
type Budget = Record<string, Record<string, Attention>>;

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let pages: Record<string, string> = {};
const seen: Budget = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-attention-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const actor = { id: u.value.id, username: "alice" } as never;
  const made = await createRepo(app, actor, { name: "vault" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  for (const [branch, path] of [["main", "README.md"], ["feature/x", "x.ts"]] as const) {
    const c = await commitToBranch(app, u.value, repo, {
      message: "Start", branch, files: [{ path, content: "v\n" }],
    } as never);
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
  const enabled = await enableApp(app, u.value, repo, { slug: "vault" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  const issue = openIssue(app, u.value, repo, { title: "Make the vault faster", body: "It is slow." });
  if (!issue.ok) throw new Error(String(issue.error));
  const pull = await openPull(app, u.value, repo, { title: "Add x", baseBranch: "main", headBranch: "feature/x" });
  if (!pull.ok) throw new Error(String(pull.error));
  const run = createRun(app.db, { repoId: repo.id, kind: "check", env: "main", commitOid: "0".repeat(40), reason: "push" });
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST", headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const r = "/alice/vault";
  const paths: Record<string, string> = {
    home: "/", repository: r, app: `${r}/app`, pull: `${r}/pulls/${pull.value.number}`,
    issue: `${r}/issues/${issue.value.number}`, "issues list": `${r}/issues`, "pulls list": `${r}/pulls`,
    runs: `${r}/runs`, run: `${r}/runs/${run.id}`, settings: "/settings",
  };
  for (const [name, path] of Object.entries(paths)) {
    const res = await fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "follow" });
    if (res.status !== 200) throw new Error(`${name} ${path} answered ${res.status}`);
    pages[name] = await res.text();
  }
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("each page stays inside its first-view budget", () => {
  for (const [name, html] of Object.entries(pages)) {
    seen[name] = {};
    for (const w of WIDTHS) seen[name]![String(w)] = firstView(html, w);
  }
  if (process.env.FORGE_ATTENTION_WRITE === "1") writeFileSync(BUDGET, `${JSON.stringify(seen, null, 2)}\n`);
  const budget = JSON.parse(readFileSync(BUDGET, "utf8")) as Budget;
  const rows: string[] = ["page".padEnd(13) + "width  words   blocks  colours"];
  const over: string[] = [];
  for (const name of Object.keys(pages))
    for (const w of WIDTHS) {
      const got = seen[name]![String(w)]!;
      const max = budget[name]?.[String(w)];
      const cell = (k: keyof Attention): string => `${got[k]}/${max?.[k] ?? "-"}`.padEnd(8);
      rows.push(`${name.padEnd(13)}${String(w).padEnd(7)}${cell("words")}${cell("blocks")}${cell("colours")}`);
      if (max === undefined) over.push(`${name} @${w}: no budget`);
      else for (const k of ["words", "blocks", "colours"] as const)
        if (got[k] > max[k]) over.push(`${name} @${w}: ${k} ${got[k]} > budget ${max[k]}`);
    }
  console.log(`${rows.join("\n")}\n(seen/budget)`);
  expect(over).toEqual([]);
});

test("the budget file names every page at both widths and no other", () => {
  // A budget for every page at both widths, and no stale page in the file.
  const budget = JSON.parse(readFileSync(BUDGET, "utf8")) as Budget;
  expect(Object.keys(budget).sort()).toEqual(Object.keys(pages).sort());
  for (const name of Object.keys(budget)) expect(Object.keys(budget[name]!)).toEqual(WIDTHS.map(String));
});
