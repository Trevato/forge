import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { checkStale } from "../src/checks/stale.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { checksForHead, getRun } from "../src/core/runs.ts";
import { readRunLog } from "../src/runs/log.ts";
import { readCombined } from "../src/git/combined.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});

describe("a kept fork's pull is checked on its combined commit (#9932)", () => {
  let dataDir = "";
  let work = "";
  let app: App;
  let checks: ChecksHandle;
  let servers: Servers;
  let base = "";
  let alice = "";
  let bob = "";
  /** The kept fork's pull the first test opens; the second checks it again. */
  let forkPull = 0;
  const cells = process.env["FORGE_CELLS"];

  async function git(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  const call = (path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const authed = (user: string, token: string) => base.replace("http://", `http://${user}:${token}@`);
  async function signup(username: string): Promise<string> {
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "kept-fork-pass" }),
      redirect: "manual",
    });
    return tokenFor(app, username, "admin", "k");
  }
  /** Ask for a check and wait for it to finish; its run and log. */
  async function checked(number: number): Promise<{ id: string; state: string; log: string; baseOid: string }> {
    const res = await call(`/api/v1/repos/alice/app/pulls/${number}/checks`, alice, {});
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: { id: string } };
    for (let i = 0; i < 400; i++) {
      const now = getRun(app.db, run.id)!;
      if (now.state !== "queued" && now.state !== "running") {
        // An approval or a push queued a check of its own first: this one may be
        // proven by it, so the log read is of every check run at this head.
        const pull = getPull(app.db, getRepo(app.db, "alice", "app")!.id, number)!;
        const all = checksForHead(app.db, pull.id, now.commitOid);
        return {
          id: run.id,
          state: now.state,
          baseOid: all.findLast((r) => r.baseOid !== "")?.baseOid ?? "",
          log: all.map((r) => readRunLog(dataDir, r.id).lines.join("\n")).join("\n"),
        };
      }
      await Bun.sleep(50);
    }
    throw new Error("the check did not finish");
  }

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-cc-"));
    work = await mkdtemp(join(tmpdir(), "forge-cc-work-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1 });
    servers = await serve(app);
    base = servers.url;
    alice = await signup("alice");
    bob = await signup("bob");
    proveAll(app);
    promote(app.db);
    await call("/api/v1/repos", alice, { name: "app", visibility: "public" });
    await git(["clone", `${authed("alice", alice)}/alice/app.git`, "a"], work);
    await Bun.write(join(work, "a/one.txt"), "one\n");
    await Bun.write(join(work, "a/forge.json"), JSON.stringify({ check: { run: "test -f two.txt" } }));
    await git(["add", "."], join(work, "a"));
    await git(["commit", "-m", "seed"], join(work, "a"));
    await git(["push", "origin", "main"], join(work, "a"));
    await call("/api/v1/repos/alice/app/forks", bob, {});
  });

  afterAll(async () => {
    await checks.stop();
    servers.stop();
    app.close();
    if (cells === undefined) delete process.env["FORGE_CELLS"];
    else process.env["FORGE_CELLS"] = cells;
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("the fork's check runs on combined/N; a pull inside the repository on its head", async () => {
    const a = join(work, "a");
    const b = join(work, "b");
    await git(["clone", `${authed("bob", bob)}/bob/app.git`, "b"], work);
    await Bun.write(join(b, "one.txt"), "bob\n");
    await Bun.write(join(b, "bob.txt"), "bob\n");
    await git(["add", "."], b);
    await git(["commit", "-am", "bob's one"], b);
    await git(["push", "origin", "main"], b);

    // Main moves on after the fork: it gains two.txt, which the check needs.
    await Bun.write(join(a, "one.txt"), "alice\n");
    await Bun.write(join(a, "two.txt"), "two\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "alice moves on"], a);
    await git(["push", "origin", "main"], a);
    const aliceMain = await git(["rev-parse", "HEAD"], a);

    const opened = await call("/api/v1/repos/alice/app/pulls", bob, {
      title: "Jay's work",
      base: "main",
      head: "main",
      headRepo: "bob/app",
    });
    expect(opened.status).toBe(201);
    const { number } = (await opened.json()) as { number: number };
    forkPull = number;
    const bare = join(app.reposRoot, "alice", "app.git");
    const tip = await git(["rev-parse", `refs/heads/combined/${number}`], bare).catch(() => "");
    expect(tip).not.toBe("");

    // A stranger's head runs once a writer approves it.
    expect((await call(`/api/v1/repos/alice/app/pulls/${number}/review-states`, alice, { state: "approved", body: "" })).status).toBe(201);
    const fork = await checked(number);
    // two.txt exists only in the combined tree: green here proves it was the one checked.
    expect(fork.state).toBe("ok");
    expect(fork.log).toContain(`checked as combined with main at ${aliceMain.slice(0, 7)}`);
    expect(fork.log).toContain(`(${tip.slice(0, 7)})`);
    expect(fork.baseOid).toBe(aliceMain);
    // The run is still found by the head, and records the commit it tested.
    const pullRow = getPull(app.db, getRepo(app.db, "alice", "app")!.id, number)!;
    const runs = checksForHead(app.db, pullRow.id, pullRow.headOid);
    expect(runs.some((r) => r.combinedOid === tip && r.commitOid === pullRow.headOid)).toBe(true);
    expect(checkStale({ baseOid: fork.baseOid }, aliceMain)).toBe(false);
    const page = await (await call(`/alice/app/pulls/${number}`, alice)).text();
    expect(page).toContain(`checked as combined with main at ${aliceMain.slice(0, 7)}`);
    expect(page).not.toContain("Checks run on the pull&#39;s head");

    // Main moves on alone: the green is of an older base now.
    await Bun.write(join(a, "four.txt"), "four\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "alice's four"], a);
    await git(["push", "origin", "main"], a);
    const moved = await git(["rev-parse", "HEAD"], a);
    expect(checkStale({ baseOid: fork.baseOid }, moved)).toBe(true);

    // A branch of the base repository itself is checked on its head, merged into main.
    await git(["checkout", "-b", "inside"], a);
    await Bun.write(join(a, "inside.txt"), "x\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "inside"], a);
    await git(["push", "origin", "inside"], a);
    const inside = await call("/api/v1/repos/alice/app/pulls", alice, {
      title: "inside",
      base: "main",
      head: "inside",
    });
    expect(inside.status).toBe(201);
    const inNumber = ((await inside.json()) as { number: number }).number;
    const own = await checked(inNumber);
    expect(own.log).toContain("merge of ");
    expect(own.log).not.toContain("checked as combined");
    const inRow = getPull(app.db, getRepo(app.db, "alice", "app")!.id, inNumber)!;
    expect(checksForHead(app.db, inRow.id, inRow.headOid).every((r) => r.combinedOid === "")).toBe(true);
    expect(own.baseOid).toBe(moved);
  }, 60_000);
  test("the fast tier diffs a combined commit against the base it was built on, not main's later tip", async () => {
    const a = join(work, "a");
    const b = join(work, "b");
    const bare = join(app.reposRoot, "alice", "app.git");
    await git(["checkout", "main"], a);
    // The gate prints the base it was given and what the pull changes against it.
    await Bun.write(
      join(a, "forge.json"),
      JSON.stringify({
        check: {
          fast: 'echo "fast base $FORGE_CHECK_BASE"; git diff --name-only "$FORGE_CHECK_BASE"..HEAD | sed "s/^/changed /"',
          run: "true",
        },
      }),
    );
    await git(["add", "."], a);
    await git(["commit", "-m", "a fast gate"], a);
    await git(["push", "origin", "main"], a);
    const builtOn = await git(["rev-parse", "HEAD"], a);

    const number = forkPull;

    // Bob pushes again: combined/N is rebuilt on main as it is now.
    await Bun.write(join(b, "bob2.txt"), "bob\n");
    await git(["add", "."], b);
    await git(["commit", "-m", "bob's second"], b);
    await git(["push", "origin", "main"], b);
    const head = await git(["rev-parse", "HEAD"], b);
    let combined = await readCombined(bare, number, head);
    for (let i = 0; i < 200 && combined?.baseOid !== builtOn; i++) {
      await Bun.sleep(50);
      combined = await readCombined(bare, number, head);
    }
    expect(combined?.baseOid).toBe(builtOn);

    // Main moves on with no recombine (as when one fails or has not run yet):
    // the combined commit still names the base it was built on.
    await git(["checkout", "-b", "late"], a);
    await Bun.write(join(a, "late.txt"), "late\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "late on main"], a);
    await git(["push", "origin", "late"], a);
    await git(["update-ref", "refs/heads/main", await git(["rev-parse", "HEAD"], a)], bare);

    expect((await call(`/api/v1/repos/alice/app/pulls/${number}/review-states`, alice, { state: "approved", body: "" })).status).toBe(201);
    const run = await checked(number);
    expect(run.state).toBe("ok");
    expect(run.log).toContain(`fast base ${builtOn}`);
    expect(run.log).toContain("changed bob2.txt");
    expect(run.log).not.toContain("changed late.txt");
  }, 60_000);
});
