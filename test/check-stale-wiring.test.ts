import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, finishRun, setRunBase } from "../src/core/runs.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("a green from an older main says so where people read it", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let pull: Pull;

  const put = async (branch: string, content: string) => {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: `edit ${branch}`,
      files: [{ path: "code.txt", content }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stale-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const made = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    await put("main", "top\nbase\n");
    await put("feat", "top\nbase\nmore\n");
    const opened = await openPull(app, alice, repo, {
      title: "Feat",
      baseBranch: "main",
      headBranch: "feat",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = getPull(app.db, repo.id, opened.value.number)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: "pull-1",
      commitOid: pull.headOid,
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "all green" });
    setRunBase(app.db, run.id, "abc1234abc1234abc1234abc1234abc1234abc12");
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the pull page reads the clock, not the green", async () => {
    const res = await fetch(`${servers.url}/alice/lib/pulls/${pull.number}/files`);
    const page = await res.text();
    expect(page).toContain("Checked against an older main");
    expect(page).not.toContain("Checks passed");
  });

  test("the terminal's pull screen says passed against an older main", async () => {
    const { app: tui, session } = createForgeApp(
      app,
      {
        sshUsername: "alice",
        remoteAddress: "127.0.0.1",
        fingerprint: "SHA256:alice",
        user: alice,
      },
      { terminal: headlessTerminal(140, 44), exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
      const end = Date.now() + 20_000;
      while (!tui.screen.toText().includes("passed against an older main")) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
    } finally {
      tui.stop();
    }
  }, 60_000);
});
