/**
 * A pull's terminal screen re-reads on a slow tick while its check runs
 * (#2280): the runner emits no event when a shard finishes, so counts that
 * arrive after the first read must still reach the line.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { getPull } from "../src/core/pulls.ts";
import { createUser } from "../src/core/users.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-tick-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("counts written after the first read reach the terminal's line", async () => {
  const made = await createUser(app.db, {
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const repo = r.value;
  for (const branch of ["main", "feat"]) {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: branch,
      files: [{ path: "code.txt", content: branch }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const opened = await openPull(app, alice, repo, {
    title: "Feat",
    baseBranch: "main",
    headBranch: "feat",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const pull = getPull(app.db, repo.id, opened.value.number)!;
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "check",
    issueId: pull.id,
    env: `pull-${pull.number}`,
    commitOid: pull.headOid,
  });
  claimRun(app.db, run.id);

  const { app: tui, session } = createForgeApp(
    app,
    {
      sshUsername: "alice",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:alice",
      user: alice,
    },
    { terminal: headlessTerminal(160, 44), exitHooks: false },
  );
  tui.start();
  try {
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
    const until = async (needle: string, ms: number) => {
      const end = Date.now() + ms;
      while (!tui.screen.toText().includes(needle)) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
    };
    await until("Check running", 20_000);
    expect(tui.screen.toText()).not.toContain(" files");
    for (const line of [
      "test-shards: 170 files in 4 shards, expected 90s",
      "── shard 1/4: a.test.ts b.test.ts",
      " 500 pass",
      " 0 fail",
      "── shard 1/4 done (exit 0, 3.0s)",
    ])
      appendRunLog(dataDir, run.id, line);
    await until("2 of 170 files", 15_000);
  } finally {
    tui.stop();
  }
}, 60_000);
