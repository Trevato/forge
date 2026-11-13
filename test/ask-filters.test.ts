/**
 * The filters an owner sets on their asks (#11820): hide an app (for a day or
 * until shown) or a kind of decision, one tap each, saved per person in the
 * forge's database. A hidden ask is never lost: it returns when the day ends
 * or on "Show all", and a trust alarm (security) is never hidden by a filter.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { applyAskFilter } from "../src/actions/ask_filter.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { askFiltersOf, clearAskFilters, HIDE_APP_DAY_WORDS, HIDE_DAY_MS, hideApp, hideKind, SHOW_ALL_WORDS } from "../src/core/ask_filters.ts";
import { createIssue, createLabel, getIssueById, setIssueLabels as setLabels } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { deleteRepo } from "../src/core/repos.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";

quietLogs();
setDefaultTimeout(30_000);

const PASSWORD = "a-long-filter-passphrase";

describe("ask filters", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie = "";
  let plain: Repo;
  let alarm: Repo;

  const lines = () => askLinesFor(app.db, alice);
  const apps = () => lines().map((l) => l.repo).sort();
  const post = (fields: [string, string][]) =>
    fetch(`${servers.url}/asks/filter`, {
      method: "POST",
      headers: { cookie: `${cookie}; forge_mode=studio`, origin: servers.url },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  async function greenPull(repo: Repo, title: string): Promise<string> {
    const bot = getUserByName(app.db, "bot")!;
    await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# x\n" }] });
    addToCrew(app, alice, repo, "bot");
    await commitToBranch(app, alice, repo, { branch: "bot/1", base: "main", message: title, files: [{ path: "F.md", content: "1\n" }] });
    const opened = await openPull(app, bot, repo, { title, body: "", baseBranch: "main", headBranch: "bot/1" });
    if (!opened.ok) throw new Error(String(opened.error));
    const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: opened.value.id, env: `pull-${opened.value.number}`, commitOid: opened.value.headOid, reason: "pull" });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    assignIssue(app, alice, repo, getIssueById(app.db, opened.value.id)!, alice);
    return opened.value.id;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ask-filters-"));
    app = createApp({ dataDir, port: 0, disk: () => ({ freeBytes: 500e9, totalBytes: 1000e9 }) });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: PASSWORD, adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: PASSWORD }), redirect: "manual" });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    await createAgent(app, alice, { username: "bot" });
    for (const name of ["plain", "alarm"]) {
      const r = await createRepo(app, alice, { name, visibility: "public" });
      if (!r.ok) throw new Error(String(r.error));
      if (name === "plain") plain = r.value;
      else alarm = r.value;
    }
    await greenPull(plain, "Plain work");
    const security = await greenPull(alarm, "Widen the board id");
    const label = createLabel(app.db, alarm.id, "security", "d00000");
    if (!label.ok) throw new Error("label");
    setLabels(app.db, security, [label.value.id]);
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("hiding an app for a day hides its asks and keeps the order of the rest", () => {
    clearAskFilters(app.db, alice.id);
    const before = lines();
    expect(before).toHaveLength(2);
    expect(before[0]!.consequence.why).toBe("security");
    hideApp(app.db, alice.id, plain.id, true);
    expect(apps()).toEqual([`alice/alarm`]);
    // Nothing is lost: the ask still exists and comes back with the filter gone.
    clearAskFilters(app.db, alice.id);
    expect(lines().map((l) => l.id)).toEqual(before.map((l) => l.id));
  });

  test("a hidden app returns when the day ends, and a hide until shown does not", () => {
    clearAskFilters(app.db, alice.id);
    const now = Date.now();
    hideApp(app.db, alice.id, plain.id, true, now);
    expect(askFiltersOf(app.db, alice.id, now + HIDE_DAY_MS - 1000).apps.has(plain.id)).toBe(true);
    expect(askFiltersOf(app.db, alice.id, now + HIDE_DAY_MS + 1000).apps.has(plain.id)).toBe(false);
    // The same through the list a person reads: an ended hide is no filter.
    app.db.query("UPDATE ask_filter SET until = ?1").run(new Date(now - 1000).toISOString());
    expect(apps()).toEqual(["alice/alarm", "alice/plain"]);
    hideApp(app.db, alice.id, plain.id, false, now);
    expect(askFiltersOf(app.db, alice.id, now + 30 * HIDE_DAY_MS).apps.has(plain.id)).toBe(true);
    clearAskFilters(app.db, alice.id);
  });

  test("a filter never hides a trust alarm, by app or by kind", () => {
    clearAskFilters(app.db, alice.id);
    hideApp(app.db, alice.id, alarm.id, false);
    hideApp(app.db, alice.id, plain.id, false);
    hideKind(app.db, alice.id, lines()[0]!.kind);
    expect(lines().map((l) => l.consequence.why)).toEqual(["security"]);
    clearAskFilters(app.db, alice.id);
  });

  test("the page: one tap hides, says how many are hidden, and one tap clears", async () => {
    clearAskFilters(app.db, alice.id);
    const page = () => fetch(`${servers.url}/asks`, { headers: { cookie: `${cookie}; forge_mode=studio` } }).then((r) => r.text());
    const first = await page();
    // Offered once for the list, not under every row: a clear form is absent, the two picks are not.
    expect(first.split('action="/asks/filter"').length - 1).toBe(2);
    expect(first).toContain(HIDE_APP_DAY_WORDS);
    expect(first).not.toContain("hidden by your filters");
    const res = await post([["do", "hide_app_day"], ["repo", plain.id], ["back", "/asks"]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/asks");
    const hidden = await page();
    expect(hidden).toContain("1 hidden by your filters");
    expect(hidden).toContain(SHOW_ALL_WORDS);
    // Home draws the same region (/live/on-you), so its count is not a mystery.
    const home = await fetch(`${servers.url}/live/on-you`, { headers: { cookie: `${cookie}; forge_mode=studio` } }).then((r) => r.text());
    expect(home).toContain("1 hidden by your filters");
    expect(hidden).not.toContain("Plain work");
    expect((await post([["do", "clear"]])).status).toBe(303);
    expect(askFiltersOf(app.db, alice.id).apps.size).toBe(0);
    expect(await page()).toContain("Plain work");
    // Bad input is refused, and it needs a signed-in person.
    expect((await post([["do", "hide_kind"], ["kind", "nope"]])).status).toBe(404);
    expect((await post([["do", "hide_app"], ["repo", "x'y"]])).status).toBe(404);
    expect((await post([["do", "explode"]])).status).toBe(404);
  });

  test("MCP asks sets the same filters in the same words, and says how many are hidden", async () => {
    clearAskFilters(app.db, alice.id);
    const token = createToken(app.db, alice.id, "rw", "rw").token;
    const call = async (args: unknown) => (await mcpTool(servers.url, token, "asks", args)) as any;
    const done = await call({ filter: "hide_app_day", app: "alice/plain" });
    expect(done.value.rows).toHaveLength(1);
    expect(done.value.filters).toEqual({ hidden: 1, line: "1 hidden by your filters" });
    expect((await call({ filter: "hide_kind", kind: "nope" })).error).toContain("kind is");
    expect((await call({ filter: "hide_app", app: "alice/none" })).error).toBeDefined();
    const cleared = await call({ filter: "clear" });
    expect(cleared.value.rows).toHaveLength(2);
    expect(cleared.value.filters).toBeUndefined();
    // The terminal and the page use the same action, so its words are one set.
    expect(applyAskFilter(app.db, alice, { do: "hide_app_day", repo: plain })).toBe("Hiding alice/plain for a day");
    expect(applyAskFilter(app.db, alice, { do: "clear" })).toBe("Showing everything again");
  });

  test("the order of what shows is the order it had, with three rows", () => {
    clearAskFilters(app.db, alice.id);
    const third = createIssue(app.db, { repoId: plain.id, authorId: alice.id, title: "Third thing" });
    if (!third.ok) throw new Error("issue");
    assignIssue(app, alice, plain, third.value, alice);
    const before = lines().map((l) => l.id);
    expect(before.length).toBeGreaterThanOrEqual(3);
    hideKind(app.db, alice.id, "assigned");
    const after = lines().map((l) => l.id);
    expect(after.length).toBeLessThan(before.length);
    expect(after).toEqual(before.filter((id) => after.includes(id)));
    clearAskFilters(app.db, alice.id);
  });

  test("the terminal's words are the page's and the tool's", async () => {
    const dash = await Bun.file("src/tui/screens/dashboard.ts").text();
    expect(dash).toContain("HIDE_APP_DAY_WORDS.toLowerCase()");
    expect(dash).toContain("SHOW_ALL_WORDS.toLowerCase()");
    const { tool } = await import("../src/http/mcp/tools/asks.ts");
    expect(tool.doc).toContain(`"${HIDE_APP_DAY_WORDS}"`);
    expect(tool.doc).toContain(`"${SHOW_ALL_WORDS}"`);
  });

  test("a deleted app's filters go with it", async () => {
    const gone = await createRepo(app, alice, { name: "gone", visibility: "public" });
    if (!gone.ok) throw new Error(String(gone.error));
    hideApp(app.db, alice.id, gone.value.id, false);
    expect(app.db.query("SELECT COUNT(*) AS n FROM ask_filter WHERE value = ?1").get(gone.value.id)).toEqual({ n: 1 });
    await deleteRepo(app.db, app.reposRoot, gone.value);
    expect(app.db.query("SELECT COUNT(*) AS n FROM ask_filter WHERE value = ?1").get(gone.value.id)).toEqual({ n: 0 });
    clearAskFilters(app.db, alice.id);
  });
});
