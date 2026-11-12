/**
 * A pull's page opens on its verdict (can it land, what holds it) and then the
 * change itself; reviews and checks come after.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstParagraph, verdictOf, type VerdictInput } from "../src/web/pages/pull-verdict.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
const numbers: Record<string, number> = {};
const cells = process.env["FORGE_CELLS"];

const pageOf = async (repo: string, tab = "/files"): Promise<string> => {
  const res = await fetch(`${servers.url}/alice/${repo}/pulls/${numbers[repo]}${tab}`, {
    headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
  });
  return res.text();
};

const commit = async (repo: Awaited<ReturnType<typeof createRepo>>, branch: string | undefined, file: string, content: string) => {
  if (!repo.ok) throw new Error(String(repo.error));
  const done = await commitToBranch(app, alice, repo.value, {
    ...(branch === undefined ? {} : { branch }),
    message: "change",
    files: [{ path: file, content }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-verdict-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  for (const name of ["ready", "held", "conflicted"]) {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    await commit(repo, undefined, "forge.json", "{}");
    await commit(repo, "topic", name === "conflicted" ? "forge.json" : "t.txt", name === "conflicted" ? '{"a":1}' : "x");
    if (name === "conflicted") await commit(repo, undefined, "forge.json", '{"b":2}');
    if (!repo.ok) throw new Error("repo");
    const pull = await openPull(app, alice, repo.value, {
      title: name,
      body: `The ${name} change, in a line.\n\nA second paragraph that stays below.`,
      baseBranch: "main",
      headBranch: "topic",
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    numbers[name] = pull.value.number;
    if (name === "held") app.db.run("UPDATE repo SET require_checks = 1 WHERE id = ?", [repo.value.id]);
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const at = (body: string, needle: string): number => {
  const i = body.indexOf(needle);
  expect(i).toBeGreaterThan(-1);
  return i;
};

for (const [name, words] of [
  ["ready", "Ready to land"],
  ["held", "Waiting for the check"],
  ["conflicted", "Conflicts with main"],
] as const) {
  test(`${name}: the files tab opens on the verdict, before the merge box`, async () => {
    const body = await pageOf(name);
    const verdict = at(body, "data-verdict");
    expect(body.indexOf(words, verdict)).toBeGreaterThan(verdict);
    expect(verdict).toBeLessThan(at(body, 'id="merge"'));
    expect(body.split("data-verdict").length).toBe(2);
  });

  test(`${name}: the pull's own page opens on the verdict, then the change, before the check`, async () => {
    const body = await pageOf(name, "");
    const verdict = at(body, "data-verdict");
    expect(body.indexOf(words, verdict)).toBeGreaterThan(verdict);
    const change = at(body, "data-change");
    expect(change).toBeGreaterThan(verdict);
    expect(body.indexOf(`The ${name} change, in a line.`, change)).toBeGreaterThan(change);
    expect(change).toBeLessThan(at(body, 'id="pull-check"'));
    expect(body).toMatch(/data-change[\s\S]*?<a href="[^"]*\/files">1 file<\/a>[\s\S]*?\+\d+ −\d+/);
    expect(body).not.toContain("and 0 more");
  });
}

test("ready offers Go to merge beside the verdict on Files; conflicted offers Resolve", async () => {
  expect(await pageOf("ready")).toMatch(/data-verdict[\s\S]*?<a[^>]*href="#merge"[^>]*>[\s\S]*?Go to merge/);
  // The pull's own page has its own Ship button below; the line carries no second action.
  const own = await pageOf("ready", "");
  const line = own.slice(own.indexOf("data-verdict"), own.indexOf("data-change"));
  expect(line).not.toContain("<a");
  expect(await pageOf("conflicted")).toMatch(/data-verdict[\s\S]*?href="\/alice\/conflicted\/pulls\/\d+\/resolve"/);
});

const base: VerdictInput = {
  merged: false, closed: false, onOrigin: false, mergeable: true, ahead: 1, conflicts: 0,
  baseBranch: "main", reviewGated: false, changesRequested: false, teamsHolding: 0,
  checksHeld: false, checkState: "ok", mayMerge: true,
};

test("verdictOf names what holds a pull, in the merge box's order", () => {
  const words = (o: Partial<VerdictInput>) => verdictOf({ ...base, ...o }, "/a/b/pulls/1").words;
  expect(words({})).toBe("Ready to land");
  expect(words({ reviewGated: true, changesRequested: true })).toBe("A reviewer asked for changes");
  expect(words({ reviewGated: true })).toBe("Waiting for a review");
  expect(words({ teamsHolding: 1 })).toBe("Waiting for a team's review");
  expect(words({ checksHeld: true, checkState: "running" })).toBe("Waiting for the check");
  expect(words({ checksHeld: true, checkState: "failed" })).toBe("The check failed");
  expect(words({ mergeable: false, conflicts: 2 })).toBe("Conflicts with main");
  expect(words({ merged: true })).toBe("Merged");
  expect(verdictOf({ ...base, mayMerge: false }, "/t").action).toBeNull();
});

test("the description's first paragraph only", () => {
  expect(firstParagraph("\n\nOne.\nStill one.\n\nTwo.")).toBe("One.\nStill one.");
  expect(firstParagraph("")).toBe("");
});
