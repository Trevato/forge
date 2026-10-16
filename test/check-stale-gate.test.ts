import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, finishRun, setRunBase } from "../src/core/runs.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepStaleAsks } from "../src/crew/stale_asks.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a green checked against an older main waits for its re-check", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let pull: Pull;
  let cookie: string;

  const put = async (branch: string, path: string, content: string) => {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: `edit ${path}`,
      files: [{ path, content }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  };
  const mainTip = async () =>
    (await resolveOid(repoDir(app.reposRoot, "alice", "lib"), "refs/heads/main"))!;
  const green = async (baseOid: string) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: "pull-1",
      commitOid: pull.headOid,
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "all green" });
    setRunBase(app.db, run.id, baseOid);
  };
  const looks = () =>
    askLinesFor(app.db, alice).some((r) => r.items.includes(`look:${pull.id}`));
  const mergeButton = async () => {
    const res = await fetch(`${servers.url}/alice/lib/pulls/${pull.number}/files`, {
      headers: { cookie },
    });
    const page = await res.text();
    const at = page.indexOf("Merge pull request");
    expect(at).toBeGreaterThan(-1);
    return { page, tag: page.slice(page.lastIndexOf("<button", at), at) };
  };

  // The terminal's pull screen, after the keys, as text.
  const terminalText = async (keys: string[] = []) => {
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
      while (!tui.screen.toText().includes("Feat")) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
      await settleApp(tui);
      for (const key of keys) {
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(tui);
      }
      return tui.screen.toText();
    } finally {
      tui.stop();
    }
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stale-gate-"));
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
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = updateRepoSettings(app.db, r.value, { requireChecks: true });
    await put("main", "code.txt", "top\nbase\n");
    await put("feat", "feat.txt", "feature\n");
    const opened = await openPull(app, alice, repo, {
      title: "Feat",
      baseBranch: "main",
      headBranch: "feat",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = getPull(app.db, repo.id, opened.value.number)!;
    await green(await mainTip());
    await sweepStaleAsks(app);
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a green on the current main asks for a look and offers the merge", async () => {
    expect(looks()).toBe(true);
    const { tag } = await mergeButton();
    expect(tag).not.toContain("disabled");
  });

  test("main moves: no look ask, and the merge button is disabled", async () => {
    await put("main", "other.txt", "moved\n");
    await sweepStaleAsks(app);
    expect(looks()).toBe(false);
    const { page, tag } = await mergeButton();
    expect(tag).toContain("disabled");
    expect(page).toContain("Waiting on checks");
    expect(page).toContain("checked against an older");
    expect(page).toContain("Check again");
  });

  test("the terminal holds the merge too: m is refused on a stale green", async () => {
    const text = await terminalText(["m"]);
    expect(text).toContain("older base");
    expect(text).toContain("press C to check again");
    expect(text).not.toContain("Ready to merge");
    expect(text).not.toContain("Merge pull request?");
    expect(getPull(app.db, repo.id, pull.number)!.mergedAt).toBeNull();
  }, 60_000);

  test("the terminal's C asks for the check again", async () => {
    // No check service runs in this test: the refusal proves C reached askCheck.
    expect(await terminalText(["C"])).toContain("no check was asked for");
  }, 60_000);

  test("a re-check green against the new main brings both back", async () => {
    await green(await mainTip());
    await sweepStaleAsks(app);
    expect(looks()).toBe(true);
    const { tag } = await mergeButton();
    expect(tag).not.toContain("disabled");
    expect(await terminalText()).toContain("Ready to merge");
  }, 60_000);
});
