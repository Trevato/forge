/**
 * The wrap-up reserve, with a stand-in Claude Code that runs out of money.
 * A run's budget is split; when the working part is spent the same session
 * gets one more turn, on the reserve, to land what exists — and a run that
 * finishes on its own never gets one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { wrapUpReserve } from "../src/crew/runner.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";

describe("the wrap-up reserve", () => {
  test("is fifteen percent, at least fifty cents, never more than half", () => {
    expect(wrapUpReserve(10)).toBeCloseTo(1.5, 5);
    expect(wrapUpReserve(5)).toBeCloseTo(0.75, 5);
    expect(wrapUpReserve(2)).toBeCloseTo(0.5, 5);
    expect(wrapUpReserve(1)).toBeCloseTo(0.5, 5);
    expect(wrapUpReserve(0.6)).toBeCloseTo(0.3, 5);
    expect(wrapUpReserve(0)).toBe(0);
  });
});

describe("a run that spends its budget", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let countFile: string;
  let argsFile: string;
  let promptFile: string;

  const invocations = (): number =>
    Number(readFileSync(countFile, "utf8").trim());
  const args = (n: number): string => readFileSync(`${argsFile}.${n}`, "utf8");
  const prompt = (n: number): string =>
    readFileSync(`${promptFile}.${n}`, "utf8");

  async function settled(
    where: (run: Run) => boolean,
    timeoutMs = 30_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "agent" }).find(where);
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(20);
    }
    throw new Error("agent run did not settle");
  }

  async function assigned(
    title: string,
    body: string,
  ): Promise<{ run: Run; number: number }> {
    rmSync(countFile, { force: true });
    const issue = openIssue(app, alice, repo, { title, body });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    return {
      run: await settled((r) => r.issueId === issue.value.id),
      number: issue.value.number,
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wrapup-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    countFile = join(dataDir, "fake.count");
    argsFile = join(dataDir, "fake.args");
    promptFile = join(dataDir, "fake.prompt");
    // The stand-in numbers its invocations and records each one's argv and
    // prompt. Told BUDGET-ME, it leaves work uncommitted and stops the way
    // Claude Code does when `--max-budget-usd` is spent; asked to wrap up,
    // it commits, pushes and describes — unless told BUDGET-ME-TWICE, when
    // the wrap-up runs out as well.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
n=$(($(cat "${countFile}" 2>/dev/null || echo 0) + 1)); echo "$n" > "${countFile}"
printf '%s\\n' "$@" > "${argsFile}.$n"
IFS= read -r first; printf '%s\n' "$first" > "${promptFile}.$n"
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
if grep -q "out of budget" "${promptFile}.$n"; then
  if grep -q BUDGET-ME-TWICE "${promptFile}.1"; then
    echo "still half-done" >> CREW.md
    echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"Reached maximum budget ($0.50)","total_cost_usd":0.51,"num_turns":2,"session_id":"fake-1","terminal_reason":"budget_exhausted"}'
    exit 1
  fi
  echo "a test for CREW.md" > CREW.test.md
  git add -A && git commit -qm "crew wrap-up" && git push -q -u origin HEAD
  echo '{"type":"result","subtype":"success","is_error":false,"result":"Done: CREW.md and its test. Not done: the fence. Look at CREW.md first.","total_cost_usd":0.02,"num_turns":2,"session_id":"fake-1","terminal_reason":"completed"}'
  exit 0
fi
if grep -q BUDGET-ME "${promptFile}.$n"; then
  echo "work by the crew, cut short" >> CREW.md
  echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"Reached maximum budget ($1.50)","total_cost_usd":1.53,"num_turns":9,"session_id":"fake-1","terminal_reason":"budget_exhausted"}'
  exit 1
fi
echo "work by the crew" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md as asked.","total_cost_usd":0.01,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 2,
      runTimeoutMs: 60_000,
      // The pump picks queued runs on a tick; 5 s by default, 20 ms here.
      tickMs: 20,
    });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("gets one wrap-up turn in the same session, on the reserve", async () => {
    // Invariant: a run that spends its working budget resumes its session once, on the reserve, and lands a pull.
    const { run, number } = await assigned(
      "Plant tulips",
      "Along the fence. BUDGET-ME",
    );
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^opened pull #\d+( \([0-9a-f]{7,40}\))?$/);
    expect(run.sessionId).toBe("fake-1");
    // Both parts.
    expect(run.costUsd).toBeCloseTo(1.55, 5);

    expect(invocations()).toBe(2);
    // The work: the budget less the reserve, a fresh session, told about
    // the reserve up front.
    expect(args(1)).toContain("--max-budget-usd\n1.50");
    expect(args(1)).not.toContain("--resume");
    expect(args(1)).toContain("one short wrap-up turn");
    expect(prompt(1)).toContain(`Issue #${number}: Plant tulips`);
    // The wrap-up: the same session, the reserve, and only the wrap-up.
    expect(args(2)).toContain("--resume\nfake-1");
    expect(args(2)).toContain("--max-budget-usd\n0.50");
    expect(prompt(2)).toContain("out of budget");
    expect(prompt(2)).not.toContain("Plant tulips");

    const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
    expect(pull.headBranch).toBe(run.branch);
    expect(pull.body).toBe(
      [
        "Done: CREW.md and its test. Not done: the fence. Look at CREW.md first.",
        "Budget reached at $1.53; this is where it stopped.",
        `Closes #${number}`,
      ].join("\n\n"),
    );
    const log = readRunLog(dataDir, run.id, 64 * 1024).lines.join("\n");
    expect(log).toContain("$0.50 of it kept for the wrap-up");
    expect(log).toContain("wrapping up with the reserve");
  }, 60_000);

  test("a run that finishes on its own gets no wrap-up", async () => {
    // Invariant: a run that completes within its working budget is invoked exactly once.
    const { run, number } = await assigned("Plant roses", "Along the wall.");
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^opened pull #\d+( \([0-9a-f]{7,40}\))?$/);
    expect(run.costUsd).toBeCloseTo(0.01, 5);
    expect(invocations()).toBe(1);
    expect(args(1)).toContain("--max-budget-usd\n1.50");
    expect(args(1)).not.toContain("--resume");
    const pull = listPulls(app.db, repo.id, { state: "open" }).find(
      (p) => p.headBranch === run.branch,
    )!;
    expect(pull.body).toBe(`Added CREW.md as asked.\n\nCloses #${number}`);
  }, 60_000);

  test("a wrap-up that runs out as well lands as before, and gets no third turn", async () => {
    // Invariant: a wrap-up that also runs out is the last turn; the leftover work is committed and opened.
    const { run, number } = await assigned(
      "Plant ivy",
      "Up the shed. BUDGET-ME-TWICE",
    );
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(
      /^opened pull #\d+, committing its leftover changes \(max_budget_reached\)$/,
    );
    expect(run.costUsd).toBeCloseTo(2.04, 5);
    expect(invocations()).toBe(2);
    const pull = listPulls(app.db, repo.id, { state: "open" }).find(
      (p) => p.headBranch === run.branch,
    )!;
    expect(pull.body).toBe(
      [
        "Reached maximum budget ($0.50)",
        "Budget reached at $1.53; this is where it stopped.",
        `Closes #${number}`,
      ].join("\n\n"),
    );
  }, 60_000);
});
