/**
 * A cancelled run ends every process it started (#10776). A person cancels
 * a running check through the same action every surface calls
 * (`cancelRepoRun`); the check's command forked a child, and that child
 * forked its own. Within 2 s none of the three is alive, and the run's
 * record says `cancelled`, not `failed`, after the check has wound down.
 *
 * Before this, the cancel marked the row and nothing else: an agent run was
 * aborted, but a check ran on to its end, its tree with it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { cancelRepoRun } from "../src/actions/runs.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { getRun, listRuns } from "../src/core/runs.ts";
import { readRunLog } from "../src/runs/log.ts";
import { createUser } from "../src/core/users.ts";
import { runningRun } from "../src/runs/stoppable.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
process.env["FORGE_CELLS"] = "off";

let dataDir: string;
let pidDir: string;
let app: App;
let checks: ChecksHandle;
const started: number[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-run-cancel-tree-"));
  pidDir = await mkdtemp(join(tmpdir(), "forge-run-cancel-pids-"));
  app = createApp({ dataDir, port: 0 });
  checks = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
});

afterAll(async () => {
  // A red run must not leave its sleepers behind on the machine.
  for (const pid of started)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone, as it should be
    }
  await checks.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(pidDir, { recursive: true, force: true });
});

/** Alive and not a zombie a parent has yet to reap. */
function alive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
  return state !== "Z" && state !== "X";
}

/** Polls, never a fixed sleep: true once every pid is gone, false at the deadline. */
async function allGoneWithin(pids: readonly number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !alive(pid))) return true;
    await Bun.sleep(20);
  }
  return pids.every((pid) => !alive(pid));
}

async function pidIn(file: string, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) return pid;
    }
    await Bun.sleep(20);
  }
  throw new Error(`${file} never named a pid`);
}

describe.skipIf(process.platform !== "linux")("a cancelled check", () => {
  test("ends its command, the child it forked and that child's child within 2 s, and says cancelled", async () => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = made.value;
    const created = await createRepo(app, alice, { name: "tree", visibility: "public" });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;

    // The command writes its own pid, forks a shell that forks a sleeper,
    // and waits. The grandchild's pid is written last (renamed into place),
    // so all three exist once it is there.
    const shell = join(pidDir, "shell.pid");
    const child = join(pidDir, "child.pid");
    const grand = join(pidDir, "grand.pid");
    const command =
      `echo $$ > ${shell}; ` +
      `sh -c 'echo $$ > ${child}; sleep 300 & echo $! > ${grand}.tmp; mv ${grand}.tmp ${grand}; wait' & ` +
      `wait`;
    const pushed = await commitToBranch(app, alice, repo, {
      message: "A check that forks and never ends",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify({ check: { run: command, install: "" } })}\n`,
        },
      ],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));

    const pids = [
      await pidIn(grand, 30_000),
      await pidIn(child, 1_000),
      await pidIn(shell, 1_000),
    ];
    started.push(...pids);
    expect(pids.every(alive)).toBe(true);

    const run = listRuns(app.db, repo.id, { kind: "check", limit: 5 }).find(
      (r) => r.commitOid === pushed.value.commitOid,
    );
    if (run === undefined) throw new Error("no check run");
    expect(run.state).toBe("running");

    const cancelled = cancelRepoRun(app, alice, repo, run.id);
    expect(cancelled.ok).toBe(true);
    expect(await allGoneWithin(pids, 2_000)).toBe(true);

    // The check winds down and lets the run go; the row keeps what the cancel wrote.
    const deadline = Date.now() + 5_000;
    while (runningRun(run.id) && Date.now() < deadline) await Bun.sleep(20);
    expect(runningRun(run.id)).toBe(false);
    const after = getRun(app.db, run.id);
    expect(after?.state).toBe("cancelled");
    expect(after?.summary).toBe("cancelled by alice");
    // The run's log says, in one line, how many processes the cancel ended (#10826).
    const ended = readRunLog(dataDir, run.id).lines.filter((l) => l.startsWith("cancel ended "));
    expect(ended).toHaveLength(1);
    expect(Number(/^cancel ended (\d+) process/.exec(ended[0]!)?.[1])).toBeGreaterThanOrEqual(pids.length);
  }, 45_000);
});
