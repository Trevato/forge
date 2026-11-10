/**
 * The crew loop with a stand-in for Claude Code: a script that speaks
 * stream-json, edits a file, commits and pushes — so the whole harness is
 * exercised (dispatch off the outbox, the per-run token, the clone and
 * branch, the prompt, landing the pull, the follow-up that resumes the
 * session, the bounds) without spending a cent or needing a login.
 *
 * One forge per test file: `crew*.test.ts` files that drive the stand-in
 * each boot their own, so they run apart and in parallel (#1798).
 */

import { expect } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";
import { addToCrew, createAgent } from "../../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../../src/actions/repos.ts";
import { startCrew, type CrewHandle } from "../../src/crew/dispatch.ts";
import { startChecks, type ChecksHandle } from "../../src/checks/service.ts";
import type { Repo } from "../../src/core/repos.ts";
import { listRuns, type Run } from "../../src/core/runs.ts";
import { createUser, type User } from "../../src/core/users.ts";
import type { InstallRunner } from "../../src/crew/workdir.ts";
import { serve, type Servers } from "../../src/http/server.ts";
import "./roomy-disk.ts";

export interface StandInCrew {
  readonly dataDir: string;
  readonly app: App;
  readonly servers: Servers;
  readonly crew: CrewHandle;
  readonly checks: ChecksHandle;
  readonly alice: User;
  /** The agent on `repo`'s crew. */
  readonly bot: User;
  /** `alice/garden`, private, one commit on main. */
  readonly repo: Repo;
  /** Where the stand-in writes the argv of its last run. */
  readonly argsFile: string;
  /** Where the stand-in writes the first line (the prompt) of its last run. */
  readonly promptFile: string;
}

/** A forge with checks and a crew whose Claude Code is the stand-in. */
export async function startStandInCrew(
  options: {
    readonly reviewBudgetMs?: number;
    readonly tickMs?: number;
    readonly now?: () => number;
    /** Stands in for `bun install` in a clone. */
    readonly installRunner?: InstallRunner;
    /** Files committed to main beside the README. */
    readonly files?: { path: string; content: string }[];
  } = {},
): Promise<StandInCrew> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-crew-"));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  const argsFile = join(dataDir, "fake.args");
  const promptFile = join(dataDir, "fake.prompt");
  // The stand-in: records its argv and prompt, does the work, pushes.
  const fake = join(dataDir, "fake-claude");
  writeFileSync(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
IFS= read -r first; printf '%s\\n' "$first" > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
if grep -q LIMIT-ME "${promptFile}" && [ ! -f PAUSED.md ]; then
echo "half-done" > PAUSED.md
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You\u2019ve hit your session limit \u00b7 resets 7:20am (UTC)","total_cost_usd":0.02,"num_turns":2,"session_id":"fake-1","terminal_reason":"api_error"}'
exit 0
fi
if grep -q PUSH-THEN-DOWN "${promptFile}" && [ ! -f "${dataDir}/down" ]; then
echo "work by the crew $(date +%s%N)" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
sleep 2.5
touch "${dataDir}/down"
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: Can'"'"'t reach the API server","total_cost_usd":0,"num_turns":0,"session_id":"fake-1","terminal_reason":"api_error"}'
exit 0
fi
if grep -q NET-DOWN "${promptFile}"; then touch "${dataDir}/down"; fi
if [ -f "${dataDir}/down" ] && grep -q "Continue where you stopped\\|NET-DOWN" "${promptFile}"; then
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: Can'"'"'t reach the API server","total_cost_usd":0,"num_turns":0,"session_id":"fake-1","terminal_reason":"api_error"}'
exit 0
fi
if grep -q "You are out of budget" "${promptFile}"; then
if [ -f "${dataDir}/wrapdown" ]; then
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: Can'"'"'t reach the API server","total_cost_usd":0,"num_turns":0,"session_id":"fake-1","terminal_reason":"api_error"}'
exit 0
fi
if [ ! -f "${dataDir}/wrapflaked" ]; then
touch "${dataDir}/wrapflaked"
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: Can'"'"'t reach the API server — check your internet or DNS (EAI_AGAIN)","total_cost_usd":0,"num_turns":0,"session_id":"fake-1","terminal_reason":"api_error"}'
else
echo '{"type":"result","subtype":"success","is_error":false,"result":"Wrapped up after the outage.","total_cost_usd":0.01,"num_turns":1,"session_id":"fake-1","terminal_reason":"completed"}'
fi
exit 0
fi
if grep -q WRAP-DOWN "${promptFile}"; then
touch "${dataDir}/wrapdown"
echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"","total_cost_usd":0.5,"num_turns":9,"session_id":"fake-1","terminal_reason":"budget_exhausted"}'
exit 0
fi
if grep -q WRAP-FLAKE "${promptFile}"; then
echo "work by the crew $(date +%s%N)" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"","total_cost_usd":0.5,"num_turns":9,"session_id":"fake-1","terminal_reason":"budget_exhausted"}'
exit 0
fi
if grep -q NET-FLAKE "${promptFile}" && [ ! -f "${dataDir}/flaked" ]; then
touch "${dataDir}/flaked"
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: Can'"'"'t reach the API server — check your internet or DNS (EAI_AGAIN)","total_cost_usd":0,"num_turns":0,"session_id":"fake-1","terminal_reason":"api_error"}'
exit 0
fi
if grep -q "Carry on from where you stopped" "${promptFile}"; then
if [ -f PAUSED.md ]; then kept=yes; else kept=no; fi
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"PAUSED.md present: '"$kept"'"}]}}'
fi
if grep -q PUSH-THEN-DECLINE "${promptFile}"; then
echo "early work $(date +%s%N)" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
n=0; while [ ! -f "${dataDir}/release" ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done
echo '{"type":"result","subtype":"success","is_error":false,"result":"DECLINED: this turned out to be out of scope.","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-5","terminal_reason":"completed"}'
exit 0
fi
if grep -q PUSH-THEN-DONE-ON-MAIN "${promptFile}"; then
tip=$(git rev-parse HEAD)
echo "early work $(date +%s%N)" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
printf '{"type":"result","subtype":"success","is_error":false,"result":"DECLINED: already done on main in %s","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-7","terminal_reason":"completed"}\n' "$tip"
touch "${dataDir}/answered"
sleep 30
exit 0
fi
if grep -q LEVEL-ME "${promptFile}"; then
git commit -q --allow-empty -m "level with main" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Nothing to change.","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-8","terminal_reason":"completed"}'
exit 0
fi
if grep -q PUSH-THEN-FAIL "${promptFile}"; then
echo "early work $(date +%s%N)" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
n=0; while [ ! -f "${dataDir}/release" ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"the tool crashed","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-6","terminal_reason":"tool_error"}'
exit 0
fi
if grep -q GRANT-TICK "${promptFile}"; then
echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Working."}],"usage":{"input_tokens":10,"output_tokens":10}}}'
sleep 1
touch "${dataDir}/ticked"
n=0; while [ ! -f "${dataDir}/spent" ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done
sleep 2.2
echo '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Still working."}],"usage":{"input_tokens":20,"output_tokens":20}}}'
sleep 30
exit 0
fi
if grep -q DECLINE-ME "${promptFile}"; then
echo "half-done edit" > SHOULD-NOT-LAND.md
echo '{"type":"result","subtype":"success","is_error":false,"result":"DECLINED: this is out of scope for me.","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-2","terminal_reason":"completed"}'
exit 0
fi
if grep -q DONE-ON-MAIN "${promptFile}"; then
tip=$(git rev-parse HEAD)
if grep -q NAMED "${promptFile}"; then said="already done on main in $tip"
elif grep -q ABSENT "${promptFile}"; then said="already done on main in deadbeefdeadbeef"
else said="already done on main"; fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"DECLINED: %s","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-4","terminal_reason":"completed"}\n' "$said"
exit 0
fi
if grep -q "You are the reviewer on this crew" "${promptFile}"; then
if grep -q SLOW-REVIEW "${promptFile}"; then exec sleep 60; fi
path=$(grep -o 'api/v1/repos/[^"\\]*/review-states' "${promptFile}" | head -1)
curl -sS -X POST -H "authorization: Bearer $FORGE_TOKEN" -H "content-type: application/json" "\${FORGE_URL%/}/$path" -d '{"state":"changes_requested","body":"Name the fence."}' > "${dataDir}/review.out"
echo '{"type":"result","subtype":"success","is_error":false,"result":"Reviewed.","total_cost_usd":0.004,"num_turns":1,"session_id":"fake-3","terminal_reason":"completed"}'
exit 0
fi
if grep -q "The check on your pull" "${promptFile}"; then echo "daffodils" >> CREW.md; fi
echo "work by the crew $(date +%s%N)" >> CREW.md
# What a sandboxed shell leaves beside the code: a temp directory with a
# package cache in it. Never the work; the clone's exclude keeps it out.
mkdir -p .tmp/cache && echo "junk" > .tmp/cache/leftover
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
if grep -q LINGER-ME "${promptFile}"; then
n=0; while [ ! -f "${dataDir}/release" ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done
fi
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Added CREW.md."},{"type":"tool_use","name":"Read","input":{"file_path":"'"$(pwd)"'/CREW.md"}},{"type":"tool_use","name":"Bash","input":{"command":"cat /etc/hosts"}},{"type":"tool_use","name":"Bash","input":{"command":"git push"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md as asked.","total_cost_usd":0.01,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed"}'
`,
  );
  chmodSync(fake, 0o755);
  const checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
  const crew = await startCrew(app, {
    forgeUrl: servers.url,
    localUrl: servers.url,
    binary: fake,
    concurrency: 1,
    budgetUsd: 1,
    runTimeoutMs: 60_000,
    networkRetryScale: 0,
    reviewBudgetMs: options.reviewBudgetMs ?? 4_000,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.installRunner === undefined
      ? {}
      : { installRunner: options.installRunner }),
  });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const alice = a.value;
  const made = await createAgent(app, alice, {
    username: "bot",
    brief: "Be brief.",
  });
  if (!made.ok) throw new Error(String(made.error));
  const bot = made.value.user;
  const created = await createRepo(app, alice, {
    name: "garden",
    visibility: "private",
  });
  if (!created.ok) throw new Error(String(created.error));
  const repo = created.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [
      { path: "README.md", content: "# garden\n" },
      ...(options.files ?? []),
    ],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  return {
    dataDir,
    app,
    servers,
    crew,
    checks,
    alice,
    bot,
    repo,
    argsFile,
    promptFile,
  };
}

export async function stopStandInCrew(standIn: StandInCrew): Promise<void> {
  await standIn.crew.stop();
  await standIn.checks.stop();
  standIn.servers.stop();
  standIn.app.close();
  await rm(standIn.dataDir, { recursive: true, force: true });
}

/** Wait for the first agent run on `repo` matching `where` to finish, and return it. */
export async function agentRunSettled(
  app: App,
  repo: Repo,
  where: (run: Run) => boolean,
  timeoutMs = 30_000,
  pollMs = 100,
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
    await Bun.sleep(pollMs);
  }
  throw new Error("agent run did not settle");
}
