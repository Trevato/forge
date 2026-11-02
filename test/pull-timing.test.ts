/** `/:owner/:name/pulls/:n`'s Server-Timing names its phases (#3192), and its Files page's (#3359). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { PULL_PAGE_PHASES } from "./helpers/pull-phases.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let number = 0;
let bigNumber = 0;
let owner: User;
let repoRow: Repo;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-timing-"));
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
  const alice = made.value;
  owner = alice;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoRow = repo.value;
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
    body: "",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  number = pull.value.number;
  // A 40-file, 2,000-line change, for the Files page.
  const big = await commitToBranch(app, alice, repo.value, {
    branch: "big",
    message: "big",
    files: Array.from({ length: 40 }, (_, f) => ({
      path: `src/m${f}.ts`,
      content: Array.from(
        { length: 50 },
        (_, i) => `export const v${f}_${i} = "<b>${i}</b>" + (${i} < 3 ? 'x' : \`y\${${i}}\`); // note & ${f}`,
      ).join("\n") + "\n",
    })),
  });
  if (!big.ok) throw new Error(JSON.stringify(big.error));
  const bigPull = await openPull(app, alice, repo.value, {
    title: "big",
    body: "",
    baseBranch: "main",
    headBranch: "big",
  });
  if (!bigPull.ok) throw new Error(JSON.stringify(bigPull.error));
  bigNumber = bigPull.value.number;
  createRun(app.db, {
    repoId: repo.value.id,
    kind: "check",
    issueId: pull.value.id,
    env: `pull-${number}`,
    commitOid: pull.value.headOid,
  });
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a pull names its read phases and render after app, summing to no more than app", async () => {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  const after = names.slice(names.indexOf("app") + 1);
  expect(after).toEqual([...PULL_PAGE_PHASES]);
  const ms = (n: string) => Number(parts[names.indexOf(n)]!.match(/dur=([\d.]+)/)![1]);
  const sum = after.reduce((t, n) => t + ms(n), 0);
  // Each is rounded to 0.1 ms, so allow one step per phase.
  expect(sum).toBeLessThanOrEqual(ms("app") + 0.1 * after.length);
  expect(ms("diff")).toBeGreaterThan(0);
  expect(ms("checks")).toBeGreaterThan(0);
});

test("a pull's Files page names session, diff, checks, reviews and render, in that order, on the 40-file seed", async () => {
  const url = `${servers.url}/alice/r/pulls/${bigNumber}/files`;
  const res = await fetch(url, { headers: { cookie } });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("m39.ts");
  expect(html).not.toContain("<b>1</b>");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  expect(names.slice(names.indexOf("app") + 1)).toEqual(["session", "diff", "diff-git", "diff-parse", "diff-highlight", "git", "checks", "reviews", "render"]);
});

/** The Server-Timing phase names of one Files-page view, and whether its diff came from the cache. */
async function filesView(): Promise<{ names: string[]; hit: boolean }> {
  const res = await fetch(`${servers.url}/alice/r/pulls/${number}/files`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  const timing = res.headers.get("server-timing") ?? "";
  return { names: timing.split(", ").map((p) => p.split(";")[0]!), hit: /(?:^|, )diff;dur=[\d.]+;desc="hit"/.test(timing) };
}

/** 40 files of 50 lines each, new content per `i` so each is a fresh head. */
async function commitHead(i: number): Promise<void> {
  const done = await commitToBranch(app, owner, repoRow, {
    branch: "topic",
    message: `head ${i}`,
    files: Array.from({ length: 40 }, (_, f) => ({
      path: `d/f${f}.ts`,
      content: Array.from({ length: 50 }, (_, l) => `export const v${i}_${f}_${l} = ${l};`).join("\n"),
    })),
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
}

test("the Files page of a 40-file diff: a new head does the diff work, a repeat view reuses it", async () => {
  // The verdict is the work done, not the milliseconds it took: wall time depends on the check
  // machine's load (#7886), while a lost cache or a re-parse on every view shows in the phases.
  for (let i = 0; i < 3; i++) {
    // A new head each time, so nothing rendered before is reused.
    await commitHead(i);
    const view = await filesView();
    expect(view.hit).toBe(false);
    expect(view.names).toContain("diff-git");
    expect(view.names).toContain("diff-parse");
    expect(view.names).toContain("diff-highlight");
  }
  // The head is unchanged now: every view reuses the rendered diff.
  for (let i = 0; i < 5; i++) {
    const view = await filesView();
    expect(view.hit).toBe(true);
    // A hit still names every other phase, so a dropped phase name is caught.
    for (const n of ["session", "diff", "git", "checks", "reviews", "render"]) expect(view.names).toContain(n);
    expect(view.names).not.toContain("diff-git");
    expect(view.names).not.toContain("diff-parse");
    expect(view.names).not.toContain("diff-highlight");
  }
});
