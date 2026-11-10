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
import { useLive, type Live } from "../src/system/live.ts";
import type { SystemView } from "../src/system/view.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const BUDGET = "docs/design/attention-budget.json";
type Budget = Record<string, Record<string, Attention>>;
// An entry may carry a "note" string beside its widths; it is read by people only.
const widthsOf = (entry: object): string[] => Object.keys(entry).filter((k) => k !== "note");

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let pages: Record<string, string> = {};
const seen: Budget = {};

// /system draws the machine it runs on (cores, disks, processes, whether the
// kernel caps cells), so the same code counts differently on every host. The
// test hands it an empty reading and one fixed sentence for each cap line.
const emptyView: SystemView = {
  at: "", seconds: 0, cpu: { busyPct: null, cores: [], history: [] }, temps: [], hottestC: null, load: null,
  memory: null, disks: [], net: [], io: [], processes: 0, groups: [], duplicates: [],
};
const fixedLive: Live = {
  read: () => emptyView, subscribe: () => () => {}, running: () => false, publish: () => {},
};
const fixedCaps = (html: string): string =>
  html.replace(/<p class="small" id="(cell-caps|cell-pids)"[^>]*>[\s\S]*?<\/p>/g, '<p class="small" id="$1">Each cell is capped.</p>');

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
  useLive(fixedLive);
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
    search: "/search", "search results": "/search?q=forge", map: "/map", flow: "/flow", system: "/system",
  };
  for (const [name, path] of Object.entries(paths)) {
    const res = await fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "follow" });
    if (res.status !== 200) throw new Error(`${name} ${path} answered ${res.status}`);
    const text = await res.text();
    pages[name] = name === "system" ? fixedCaps(text) : text;
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
  if (process.env.FORGE_ATTENTION_WRITE === "1") {
    const old = JSON.parse(readFileSync(BUDGET, "utf8")) as Record<string, { note?: string }>;
    const out: Record<string, unknown> = {};
    for (const [n, v] of Object.entries(seen)) out[n] = old[n]?.note ? { ...v, note: old[n]!.note } : v;
    writeFileSync(BUDGET, `${JSON.stringify(out, null, 2)}\n`);
  }
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
  for (const name of Object.keys(budget)) expect(widthsOf(budget[name]!)).toEqual(WIDTHS.map(String));
});
