/**
 * The running limits (#918): a fresh account may have only so many live
 * previews, concurrent agent runs and concurrent checks. One past the limit
 * does not start — a preview's run fails, a run or check stays queued — and
 * its words name the limit and the count ("1 of 1 live previews"). The
 * owner's own (admin) account starts the same things freely. Every wait is
 * for a named state or a flag file, never a guess at timing, and each wait outlasts a check machine running the whole suite at once.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { EnvName } from "../src/apps/data.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { startChecks } from "../src/checks/service.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createRun, listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { serve } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { heldRuns } from "../src/runs/held.ts";
import { QUOTA_KEYS, getQuota, runningLimitSentence, setQuota } from "../src/settings/quotas.ts";
import { promote } from "./helpers/members.ts";

async function until<T>(read: () => T | undefined, ms = 120_000, what = "the awaited state"): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error(`did not happen in time: ${what}`);
}

async function twoUsers(app: App): Promise<{ alice: User; bob: User }> {
  const users: User[] = [];
  for (const username of ["alice", "bob"]) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    users.push(made.value);
  }
  promote(app.db, ...users);
  return { alice: users[0]!, bob: users[1]! };
}

describe("the limits themselves", () => {
  test("each running limit is a quota key, unset by default, and never asked of a forge admin", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-qrun-unit-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const { alice, bob } = await twoUsers(app);
      for (const key of ["previews", "runs", "checks"] as const) {
        expect(QUOTA_KEYS).toContain(key);
        expect(getQuota(app.db, key)).toBeNull();
        expect(runningLimitSentence(app.db, key, "things", bob.id, () => 9)).toBeUndefined();
        setQuota(app.db, key, 3, alice.id);
        expect(runningLimitSentence(app.db, key, "things", bob.id, () => 2)).toBeUndefined();
        expect(runningLimitSentence(app.db, key, "things", bob.id, () => 3)).toBe("3 of 3 things");
        expect(runningLimitSentence(app.db, key, "things", alice.id, () => 99)).toBeUndefined();
      }
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

/** How long one preview may take to settle: most of the 600 s test, since a deploy shares its gate with the app's own production deploy. */
const PREVIEW_SETTLES_MS = 420_000;

describe("live previews", () => {
  test("a fresh account's second preview is refused with the count on its run; the owner's two both run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-qrun-previews-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    const runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    try {
      const { alice, bob } = await twoUsers(app);
      setQuota(app.db, "previews", 1, alice.id);
      const pullOf = async (who: User, repo: Repo, name: string): Promise<number> => {
        const branch = await commitToBranch(app, who, repo, {
          branch: `feature/${name}`,
          base: "main",
          message: name,
          files: [{ path: `${name}.md`, content: `${name}\n` }],
        });
        if (!branch.ok) throw new Error(JSON.stringify(branch.error));
        const opened = await openPull(app, who, repo, {
          title: name,
          baseBranch: "main",
          headBranch: `feature/${name}`,
        });
        if (!opened.ok) throw new Error(String(opened.error));
        return opened.value.number;
      };
      const state = (record: Parameters<typeof runtime.status>[0], n: number) =>
        runtime.status(record).find((e) => e.env === `pull-${n}`)?.state;
      const deployOf = (repo: Repo, n: number): Run | undefined =>
        listRuns(app.db, repo.id, { kind: "deploy", limit: 20 }).find((r) => r.env === `pull-${n}`);
      // A preview that fits is waited for however loaded the machine (the
      // test's own timeout is the bound); if it never runs, the failure
      // names where it stood and what its deploy run said.
      const running = async (record: Parameters<typeof runtime.status>[0], repo: Repo, n: number): Promise<void> => {
        const seen = () => {
          const env = runtime.status(record).find((e) => e.env === `pull-${n}`);
          const run = deployOf(repo, n);
          return `pull-${n} is ${env?.state ?? "unknown"}${env?.error ? ` (${env.error})` : ""}; its deploy run is ${run ? `${run.state}: ${run.summary}` : "not made"}`;
        };
        try {
          await until(() => (state(record, n) === "running" ? true : undefined), PREVIEW_SETTLES_MS, `pull-${n} running`);
        } catch (error) {
          throw new Error(`${String(error)} — ${seen()}`);
        }
      };

      const mine = await newApp(app, bob, { name: "bobs", description: "x", visibility: "public" });
      if (!mine.ok) throw new Error(String(mine.error));
      const first = await pullOf(bob, mine.value.repo, "one");
      await running(mine.value.app, mine.value.repo, first);
      const second = await pullOf(bob, mine.value.repo, "two");
      const refused = await until(() => {
        const run = deployOf(mine.value.repo, second);
        return run?.state === "failed" ? run : undefined;
      }, PREVIEW_SETTLES_MS, `pull-${second}'s deploy refused`);
      expect(refused.summary).toContain("1 of 1 live previews");
      expect(readRunLog(dataDir, refused.id).lines.join("\n")).toContain("1 of 1 live previews");
      expect(state(mine.value.app, second)).not.toBe("running");
      expect(state(mine.value.app, first)).toBe("running");

      const theirs = await newApp(app, alice, { name: "alices", description: "x", visibility: "public" });
      if (!theirs.ok) throw new Error(String(theirs.error));
      const a = await pullOf(alice, theirs.value.repo, "a");
      const b = await pullOf(alice, theirs.value.repo, "b");
      for (const n of [a, b]) await running(theirs.value.app, theirs.value.repo, n);
    } finally {
      await runtime.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("two previews deploying together", () => {
  // A regression guard: the deploys are decided one after the other, so this passes without the ordering too.
  test("at a limit of one, the older deploy starts and only the younger is refused", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-qrun-burst-previews-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    const runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    try {
      const { alice, bob } = await twoUsers(app);
      setQuota(app.db, "previews", 1, alice.id);
      const made = await newApp(app, bob, { name: "bobs", description: "x", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const { repo, app: record } = made.value;
      for (const name of ["one", "two"]) {
        const branch = await commitToBranch(app, bob, repo, {
          branch: `feature/${name}`,
          base: "main",
          message: name,
          files: [{ path: `${name}.md`, content: `${name}\n` }],
        });
        if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      }
      // Both pulls open in the same breath, so both deploys are in flight together.
      const opened = await Promise.all(
        ["one", "two"].map((name) =>
          openPull(app, bob, repo, { title: name, baseBranch: "main", headBranch: `feature/${name}` }),
        ),
      );
      const numbers = opened.map((o) => {
        if (!o.ok) throw new Error(String(o.error));
        return o.value.number;
      });
      const deploys = () =>
        numbers.map((n) => listRuns(app.db, repo.id, { kind: "deploy", limit: 20 }).find((r) => r.env === `pull-${n}`));
      await until(() => {
        const runs = deploys();
        return runs.every((r) => r !== undefined && ["failed", "ok", "running"].includes(r.state)) ? true : undefined;
      });
      const states = () => runtime.status(record).filter((e) => e.env.startsWith("pull-")).map((e) => e.state);
      await until(() => (states().includes("running") ? true : undefined));
      const failed = deploys().filter((r) => r?.state === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.summary).toContain("1 of 1 live previews");
      expect(states().filter((s) => s === "running")).toHaveLength(1);
    } finally {
      await runtime.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("a sleeping preview woken at the limit", () => {
  test("stays asleep, and the page a visitor sees says why", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-qrun-wake-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    // Read at every sweep: raised once both are asleep, so the one woken
    // cannot rest again (freeing the slot) however slow the machine is.
    const sleepAfter = { production: 3_600_000, preview: 2_500 };
    const runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      // Previews rest after a few seconds unasked; production is left alone.
      sleepAfterMs: sleepAfter,
      sweepEveryMs: 100,
    });
    await runtime.start();
    try {
      const { alice, bob } = await twoUsers(app);
      const made = await newApp(app, bob, { name: "bobs", description: "x", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const { repo, app: record } = made.value;
      const envs: EnvName[] = [];
      for (const name of ["one", "two"]) {
        const branch = await commitToBranch(app, bob, repo, {
          branch: `feature/${name}`,
          base: "main",
          message: name,
          files: [{ path: `${name}.md`, content: `${name}\n` }],
        });
        if (!branch.ok) throw new Error(JSON.stringify(branch.error));
        const opened = await openPull(app, bob, repo, {
          title: name,
          baseBranch: "main",
          headBranch: `feature/${name}`,
        });
        if (!opened.ok) throw new Error(String(opened.error));
        envs.push(`pull-${opened.value.number}`);
      }
      const status = (env: EnvName) => runtime.status(record).find((e) => e.env === env);
      // No limit yet: both come up, then both rest, unasked.
      for (const env of envs) await until(() => (status(env)?.state === "asleep" ? true : undefined));
      sleepAfter.preview = 3_600_000;
      // The limit is set only now, so the two asleep are the whole story: one wake fits, the next does not.
      setQuota(app.db, "previews", 1, alice.id);
      expect(await runtime.wake(record, envs[0]!)).toBeDefined();
      expect(status(envs[0]!)?.state).toBe("running");

      const url = new URL(status(envs[1]!)!.url);
      const page = await fetch(`${servers.url}/`, { headers: { host: url.host }, redirect: "manual" });
      const html = await page.text();
      expect(status(envs[1]!)?.state).toBe("asleep");
      expect(status(envs[1]!)?.port).toBeUndefined();
      expect(status(envs[1]!)?.error).toContain("1 of 1 live previews");
      expect(page.status).toBeGreaterThanOrEqual(500);
      expect(html).toContain("stays asleep");
      expect(html).toContain("1 of 1 live previews");
    } finally {
      await runtime.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("concurrent checks", () => {
  // A regression guard: `schedule()` re-reads what is in flight after every start, so this passes without per-pick asking too.
  test("two checks of one account queued together do not start together", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-qrun-burst-checks-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    const flag = (name: string) => join(dataDir, `go-${name}`);
    let checks: ReturnType<typeof startChecks> | undefined;
    try {
      const { alice, bob } = await twoUsers(app);
      setQuota(app.db, "checks", 1, alice.id);
      const runs: { repo: Repo; run: Run }[] = [];
      // Queued before the checks service exists, so its first look sees both.
      for (const name of ["x1", "x2"]) {
        const made = await createRepo(app, bob, { name, visibility: "public" });
        if (!made.ok) throw new Error(String(made.error));
        const pushed = await commitToBranch(app, bob, made.value, {
          message: "Check me",
          files: [
            {
              path: "forge.json",
              content: JSON.stringify({ check: { run: `while [ ! -f ${flag(name)} ]; do sleep 0.05; done` } }),
            },
          ],
        });
        if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
        const run = createRun(app.db, {
          repoId: made.value.id,
          kind: "check",
          env: "production",
          commitOid: pushed.value.commitOid,
          reason: "push",
        });
        runs.push({ repo: made.value, run });
      }
      checks = startChecks(app, { forgeUrl: servers.url, concurrency: 4 });
      const stateOf = (i: number) => listRuns(app.db, runs[i]!.repo.id, { kind: "check", limit: 5 })[0]?.state;
      const said = (i: number) => readRunLog(dataDir, runs[i]!.run.id).lines.join("\n").includes("1 of 1 concurrent checks");
      // One has started and the other has been told why it waits: both were weighed.
      await until(() => (said(0) || said(1) ? true : undefined));
      const states = [stateOf(0), stateOf(1)].sort();
      expect(states).toEqual(["queued", "running"]);
      for (const name of ["x1", "x2"]) writeFileSync(flag(name), "");
      await until(() => (stateOf(0) === "ok" && stateOf(1) === "ok" ? true : undefined));
    } finally {
      for (const name of ["x1", "x2"]) writeFileSync(flag(name), "");
      await checks?.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);

  test("a fresh account's second check waits queued, naming the count; the owner's two run at once; a freed slot starts the waiter", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-qrun-checks-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    const checks = startChecks(app, { forgeUrl: servers.url, concurrency: 4 });
    const flag = (name: string) => join(dataDir, `go-${name}`);
    try {
      const { alice, bob } = await twoUsers(app);
      setQuota(app.db, "checks", 1, alice.id);
      const push = async (who: User, name: string): Promise<Repo> => {
        const made = await createRepo(app, who, { name, visibility: "public" });
        if (!made.ok) throw new Error(String(made.error));
        const pushed = await commitToBranch(app, who, made.value, {
          message: "Check me",
          files: [
            {
              path: "forge.json",
              content: JSON.stringify({
                check: { run: `while [ ! -f ${flag(name)} ]; do sleep 0.05; done` },
              }),
            },
          ],
        });
        if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
        return made.value;
      };
      const checkOf = (repo: Repo): Run | undefined =>
        listRuns(app.db, repo.id, { kind: "check", limit: 10 })[0];
      const stateOf = (repo: Repo) => checkOf(repo)?.state;

      const b1 = await push(bob, "b1");
      await until(() => (stateOf(b1) === "running" ? true : undefined), 120_000, "b1 running");
      const b2 = await push(bob, "b2");
      const waiting = await until(() => {
        const run = checkOf(b2);
        return run !== undefined && readRunLog(dataDir, run.id).lines.join("\n").includes("1 of 1 concurrent checks")
          ? run
          : undefined;
      }, 120_000, "b2 queued with its count in the log");
      expect(stateOf(b2)).toBe("queued");
      expect(waiting.state).toBe("queued");

      const a1 = await push(alice, "a1");
      const a2 = await push(alice, "a2");
      await until(() => (stateOf(a1) === "running" && stateOf(a2) === "running" ? true : undefined), 120_000, "a1 and a2 running");

      // The slot frees: bob's waiter is started, never dropped.
      writeFileSync(flag("b1"), "");
      await until(() => (stateOf(b1) === "ok" ? true : undefined), 120_000, "b1 ok");
      await until(() => (stateOf(b2) === "running" ? true : undefined), 120_000, "b2 running once b1 freed its slot");
      for (const name of ["b2", "a1", "a2"]) writeFileSync(flag(name), "");
      await until(() => ([b2, a1, a2].every((r) => stateOf(r) === "ok") ? true : undefined), 120_000, "b2, a1, a2 ok");
      expect(existsSync(flag("b2"))).toBe(true);
    } finally {
      await checks.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("concurrent runs", () => {
  test("a fresh account's second run waits queued, naming the count, until its first ends", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-qrun-runs-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    const flag = join(dataDir, "go");
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s","model":"fake"}'
while [ ! -f ${flag} ]; do sleep 0.05; done
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
`,
    );
    chmodSync(fake, 0o755);
    const crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 4,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    try {
      const { alice, bob } = await twoUsers(app);
      setQuota(app.db, "runs", 1, alice.id);
      const assignTwo = async (who: User, repoName: string): Promise<Repo> => {
        const made = await createRepo(app, who, { name: repoName, visibility: "private" });
        if (!made.ok) throw new Error(String(made.error));
        const seeded = await commitToBranch(app, who, made.value, {
          message: "Start",
          files: [{ path: "README.md", content: "# x\n" }],
        });
        if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
        for (const name of [`${repoName}-bot`, `${repoName}-bee`]) {
          const agent = await createAgent(app, alice, { username: name, brief: "Be brief." });
          if (!agent.ok) throw new Error(String(agent.error));
          expect(addToCrew(app, who, made.value, name).ok).toBe(true);
          const issue = openIssue(app, who, made.value, { title: `Plant ${name}`, body: "Along the fence." });
          if (!issue.ok) throw new Error(String(issue.error));
          expect(assignIssue(app, who, made.value, issue.value, agent.value.user).ok).toBe(true);
        }
        return getRepo(app.db, who.username, repoName)!;
      };
      const runsOf = (repo: Repo) => listRuns(app.db, repo.id, { kind: "agent", limit: 10 });
      const count = (repo: Repo, state: string) => runsOf(repo).filter((r) => r.state === state).length;

      const mine = await assignTwo(bob, "garden");
      await until(() => (count(mine, "running") === 1 && count(mine, "queued") === 1 ? true : undefined));
      const waiting = runsOf(mine).find((r) => r.state === "queued")!;
      await until(() =>
        readRunLog(dataDir, waiting.id).lines.join("\n").includes("1 of 1 concurrent runs") ? true : undefined,
      );
      expect(count(mine, "running")).toBe(1);
      // The pass that held it says so, for vitals (#9403).
      expect(heldRuns(app.db).get(waiting.id)).toBe("limit");

      const theirs = await assignTwo(alice, "orchard");
      await until(() => (count(theirs, "running") === 2 ? true : undefined));

      writeFileSync(flag, "");
      await until(() => (runsOf(mine).every((r) => r.state !== "queued" && r.state !== "running") ? true : undefined));
      expect(runsOf(mine)).toHaveLength(2);
    } finally {
      writeFileSync(flag, "");
      await crew.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);
});
