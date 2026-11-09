/**
 * Two addresses for one forge. The forge clones an agent's working tree
 * over its local address; the remotes the agent is left with carry the
 * forge's public URL, the forge as the agent is told it. Inside the shell
 * sandbox `localhost` is the sandbox's own and reaches nothing, while a
 * named host goes out through the sandbox's proxy — so remotes on the
 * local address left `git push` nowhere to go, and the crew's only way to
 * push was to leave the sandbox.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** The same server by another name: what the agent is told, against what the forge uses. */
function otherName(url: string): string {
  return url.includes("127.0.0.1")
    ? url.replace("127.0.0.1", "localhost")
    : url.replace("localhost", "127.0.0.1");
}

describe("the remotes an agent is handed", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let publicUrl: string;
  let remotesFile: string;

  async function settled(where: (run: Run) => boolean): Promise<Run> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "agent" }).find(where);
      if (run && run.state !== "queued" && run.state !== "running") return run;
      await Bun.sleep(20);
    }
    throw new Error("agent run did not settle");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-remotes-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    publicUrl = otherName(servers.url);
    remotesFile = join(dataDir, "remotes.out");
    // The stand-in writes down where its remotes point, then pushes the
    // way an agent does: a plain `git push`, trusting the clone it was
    // handed to know where to go.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
{ git remote get-url origin; git remote get-url --push origin; } > "${remotesFile}"
echo "work by the crew" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md as asked.","total_cost_usd":0.01,"num_turns":2,"session_id":"fake-1","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(app, {
      forgeUrl: publicUrl,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      // The pump's clock: a run queued is taken on the next tick, not 5 s on.
      tickMs: 20,
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
    await crew?.stop();
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // The issue and its first run, made by the first test; the second visits
  // the clone that run left.
  let issue: Issue;
  let firstRun: Run;

  // The stand-in runs outside any sandbox, so what this proves is the
  // address the agent is handed and that a plain push over it lands — not
  // the sandbox's own reach, which is Claude Code's to hold.
  test("carry the forge's public URL, fetch from the repository and push to the agent's fork, and a plain push lands", async () => {
    // Invariant: a fresh clone's fetch and push remotes are the forge's public URL, and a plain `git push` over them opens the pull.
    expect(publicUrl).not.toBe(servers.url);
    const opened = openIssue(app, alice, repo, {
      title: "Plant tulips",
      body: "Along the fence.",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    issue = opened.value;
    expect(assignIssue(app, alice, repo, issue, bot).ok).toBe(true);
    const run = await settled((r) => r.issueId === issue.id);
    firstRun = run;
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^opened pull #\d+( \([0-9a-f]{7,40}\))?$/);
    const [fetchUrl, pushUrl] = readFileSync(remotesFile, "utf8")
      .trim()
      .split("\n");
    expect(fetchUrl).toBe(`${publicUrl}/alice/garden.git`);
    expect(pushUrl).toBe(`${publicUrl}/bot/garden.git`);
    const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
    expect(pull.headBranch).toBe(run.branch);
  });

  // A clone kept from before the forge changed where its remotes point —
  // a run resumed after a release — is set right again on every visit,
  // not only when it is first made.
  test("are set right again on a kept clone whose remotes went stale", async () => {
    // Invariant: a kept clone's stale remotes are reset to the forge's public URL on every visit, and the next push updates the pull.
    expect(firstRun?.state).toBe("ok");
    const clone = join(
      dataDir,
      "crew",
      "bot",
      repo.id,
      String(issue.number),
    );
    for (const key of ["remote.origin.url", "remote.origin.pushurl"]) {
      const stale = Bun.spawnSync(
        ["git", "config", key, "http://localhost:1/stale.git"],
        { cwd: clone },
      );
      expect(stale.exitCode).toBe(0);
    }
    const said = addComment(
      app,
      alice,
      repo,
      issue,
      "Also plant daffodils.",
    );
    if (!said.ok) throw new Error(String(said.error));
    const again = await settled(
      (r) => r.issueId === issue.id && r.id !== firstRun.id,
    );
    expect(again.state).toBe("ok");
    expect(again.summary).toMatch(/^updated pull #\d+/);
    const [fetchAgain, pushAgain] = readFileSync(remotesFile, "utf8")
      .trim()
      .split("\n");
    expect(fetchAgain).toBe(`${publicUrl}/alice/garden.git`);
    expect(pushAgain).toBe(`${publicUrl}/bot/garden.git`);
  });
});
