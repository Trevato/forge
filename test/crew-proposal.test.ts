/**
 * Conflicts, part 3: one tap has the crew propose the resolution. A stand-in
 * Claude Code merges the base into the pull's own branch, resolves the file
 * and pushes; the proposal lands as a commit on the head branch and its
 * report is the note on the pull.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { proposalOf, proposeResolution, resolutionBrief } from "../src/crew/proposal.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { getPull, listPulls, pullDir, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, listRuns, type Run } from "../src/core/runs.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

describe("the crew proposes a resolution", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let pull: Pull;
  let token: string;
  let promptFile: string;

  async function settled(where: (run: Run) => boolean): Promise<Run> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "agent" }).find(where);
      if (run && ["ok", "failed", "cancelled"].includes(run.state)) return run;
      await Bun.sleep(100);
    }
    throw new Error("agent run did not settle");
  }

  const tap = () =>
    fetch(`${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve/propose`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proposal-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    promptFile = join(dataDir, "fake.prompt");
    // Told to propose, it merges the base in, keeps both sides' lines and
    // pushes; otherwise it changes the file the way a builder would.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
if printf '%s' "$first" | grep -q "propose how pull"; then
  printf '%s' "$first" > "${promptFile}"
  git merge origin/main >/dev/null 2>&1
  printf 'both lines\\n' > notes.txt
  git add -A && git commit -qm "Resolve notes.txt" && git push -q -u origin HEAD
  echo '{"type":"result","subtype":"success","is_error":false,"result":"Kept both lines in notes.txt: the crew wrote one, alice the other, and nothing needs one to win.","total_cost_usd":0.01,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed"}'
  exit 0
fi
echo "crew line" > notes.txt
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Wrote notes.txt.","total_cost_usd":0.01,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed"}'
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
      // A queued run starts on the next tick, not up to 5 s later.
      tickMs: 50,
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
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "public",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "notes.txt", content: "base line\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const t = await fetch(`${servers.url}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "alice",
        password: "a-good-passphrase",
        name: "t",
        scope: "rw",
      }),
    }).then((r) => r.json() as Promise<{ token?: string }>);
    token = t.token ?? "";

    // The builder's pull, then the base moves under it.
    const issue = openIssue(app, alice, repo, { title: "Write notes", body: "Do it." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, made.value.user).ok).toBe(true);
    await settled((r) => r.issueId === issue.value.id);
    pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
    const moved = await commitToBranch(app, alice, repo, {
      message: "Alice rewrites the line",
      files: [{ path: "notes.txt", content: "alice line\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  }, 60_000);

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the brief carries both sides, the blocks and the tests", async () => {
    const text = await resolutionBrief(app, repo, pull);
    expect(text).toContain("Alice rewrites the line");
    expect(text).toContain("crew work");
    expect(text).toContain("### notes.txt — 1 block");
    expect(text).toContain("alice line");
    expect(text).toContain("crew line");
    expect(text).toContain("No test names these files");
  });

  test("the page offers the tap to a writer, not to a reader", async () => {
    const page = await fetch(
      `${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve`,
      { headers: { authorization: `Bearer ${token}` } },
    ).then((r) => r.text());
    expect(page).toContain("Ask the crew to fix it");
    expect(page).toMatch(/id="crew-proposal"[^>]*>\s*<div\s+class="card bare"/);
    expect(page).toContain("<h2>The crew</h2>");
    expect(page).toContain(`pulls/${pull.number}/resolve/propose`);
    const stranger = await fetch(
      `${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve`,
    );
    expect(await stranger.text()).not.toContain("Ask the crew to fix it");
  });

  test("a reader's tap, and a cross-origin one, start nothing", async () => {
    const before = listRuns(app.db, repo.id, { kind: "agent" }).length;
    expect((await proposeResolution(app, bob, repo, pull)).ok).toBe(false);
    expect(
      (
        await fetch(
          `${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve/propose`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
            redirect: "manual",
          },
        )
      ).status,
    ).toBe(403);
    expect(listRuns(app.db, repo.id, { kind: "agent" }).length).toBe(before);
  });

  test("one tap lands a commit on the head branch and a note on the pull", async () => {
    const res = await tap();
    expect(res.status).toBe(303);
    const run = await settled((r) => r.reason === "resolve");
    expect(run.state).toBe("ok");
    expect(run.branch).toBe(pull.headBranch);

    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("propose how pull");
    expect(prompt).toContain("alice line");

    const now = getPull(app.db, repo.id, pull.number)!;
    expect(now.headOid).not.toBe(pull.headOid);
    const note = listComments(app.db, pull.id).find((c) => c.body.includes("Kept both lines"));
    expect(note?.authorName).toBe("bot");

    // The page now shows the proposal, its note and the file to edit.
    const page = await fetch(
      `${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve`,
      { headers: { authorization: `Bearer ${token}` } },
    ).then((r) => r.text());
    expect(page).toContain("The crew proposed a resolution");
    expect(page).toContain("Kept both lines");
    expect(page).toContain('id="crew-proposal" data-live="run.queued,run.started,run.finished');
    expect(page).toContain(`/edit/`);
    expect(page).toContain(now.headOid.slice(0, 7));
  });

  test("with nothing to resolve, the tap is refused", async () => {
    const again = await proposeResolution(app, alice, repo, getPull(app.db, repo.id, pull.number)!);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("no_conflict");
  });

  /** Open the pull in the terminal as `user`, press `v`, then each of `keys`. */
  async function terminal(
    user: User,
    keys: string[],
    until?: (text: string) => boolean,
  ): Promise<string> {
    const { app: tui, session } = createForgeApp(
      app,
      {
        sshUsername: user.username,
        remoteAddress: "127.0.0.1",
        fingerprint: `SHA256:${user.username}`,
        user,
      },
      { terminal: headlessTerminal(140, 44), exitHooks: false },
    );
    tui.start();
    const press = async (key: string) => {
      tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    try {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
      const end = Date.now() + 20_000;
      while (!tui.screen.toText().includes("Conflicts in 1 file")) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
      await press("v");
      // A writer's `v` opens the conflict blocks: wait for them to be drawn.
      // A reader's `v` is ignored and draws nothing to wait for; what a
      // reader may not do is asserted on the keys that follow.
      const writer = user.id === alice.id;
      while (writer && !tui.screen.toText().includes("conflict block in")) {
        if (Date.now() > end) throw new Error(`v never opened the conflict blocks:\n${tui.screen.toText()}`);
        await settleApp(tui);
        await Bun.sleep(20);
      }
      for (const key of keys) await press(key);
      while (until !== undefined && !until(tui.screen.toText())) {
        if (Date.now() > end + 30_000) throw new Error(tui.screen.toText());
        await Bun.sleep(100);
        await press("r");
      }
      return tui.screen.toText();
    } finally {
      tui.stop();
    }
  }

  test("the terminal's c has the crew propose; a reader's c queues nothing", async () => {
    // The base moves again, so the pull conflicts once more.
    const moved = await commitToBranch(app, alice, repo, {
      message: "Alice rewrites it again",
      files: [{ path: "notes.txt", content: "alice line two\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const before = listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) => r.reason === "resolve",
    ).length;

    const reader = await terminal(bob, ["c"]);
    expect(reader).not.toContain("have the crew propose");
    expect(
      listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.reason === "resolve").length,
    ).toBe(before);
    expect((await proposeResolution(app, bob, repo, getPull(app.db, repo.id, pull.number)!)).ok).toBe(false);

    const screen = await terminal(
      alice,
      ["c"],
      // The first proposal's card is still on show until the head moves, so
      // wait for the second run to settle and the card to name its commit.
      (t) => {
        const run = listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.reason === "resolve");
        const head = getPull(app.db, repo.id, pull.number)!.headOid.slice(0, 7);
        return run.length === before + 1 && run[0]!.state === "ok" && t.includes(head);
      },
    );
    const runs = listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.reason === "resolve");
    expect(runs.length).toBe(before + 1);
    expect(screen).toContain("Kept both lines");
  }, 90_000);

  test("the card names only the commit the run left: a later push hides it", async () => {
    const landed = await fetch(
      `${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve`,
      { headers: { authorization: `Bearer ${token}` } },
    ).then((r) => r.text());
    expect(landed).toContain("The crew proposed a resolution");
    // Someone pushes to the pull's branch (a fork's, so the row follows by a fetch).
    app.db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(pull.id, "a".repeat(40));
    const page = await fetch(
      `${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve`,
      { headers: { authorization: `Bearer ${token}` } },
    ).then((r) => r.text());
    expect(page).not.toContain("The crew proposed a resolution");
  });

  test("a failed proposal is not left on the page once nothing conflicts", async () => {
    const now = getPull(app.db, repo.id, pull.number)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: pull.id,
      reason: "resolve",
    });
    app.db
      .query("UPDATE run SET state = 'failed', summary = 'it gave up' WHERE id = ?1")
      .run(run.id);
    app.db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(pull.id, now.headOid);
    const dir = await pullDir(app.db, app.reposRoot, repo, getPull(app.db, repo.id, pull.number)!);
    const seen = await proposalOf(app, repo, getPull(app.db, repo.id, pull.number)!, dir);
    expect(seen.kind).toBe("none");
  });

  const resolvePage = () =>
    fetch(`${servers.url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}/resolve`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.text());
  const current = () => getPull(app.db, repo.id, pull.number)!;
  const agentRuns = () => listRuns(app.db, repo.id, { kind: "agent" }).length;

  test("a failed proposal on a pull that still conflicts says why, on the page and in the terminal", async () => {
    // The base moves once more, so the pull conflicts again; the last
    // resolve run is the failed one from the test above.
    const moved = await commitToBranch(app, alice, repo, {
      message: "Alice rewrites it a third time",
      files: [{ path: "notes.txt", content: "alice line three\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const page = await resolvePage();
    expect(page).toContain("The last proposal did not land (failed): it gave up");
    expect(page).toContain("Ask the crew to fix it");

    const screen = await terminal(alice, [], (t) => t.includes("did not land"));
    expect(screen).toContain("The last proposal did not land (failed): it gave up");
  }, 60_000);

  test("while an agent run is under way, the tap is busy: no second run, no button", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: pull.id,
      reason: "comment",
    });
    // A live run holds its lease; without a heartbeat the crew's next tick
    // takes it for one a restart interrupted and queues it again for real.
    app.db
      .query("UPDATE run SET state = 'running', heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
      .run(run.id);
    const before = agentRuns();
    const refused = await proposeResolution(app, alice, repo, current());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("busy");
    expect(agentRuns()).toBe(before);
    const page = await resolvePage();
    expect(page).toContain("The crew is already working on this pull.");
    expect(page).not.toContain("Ask the crew to fix it");
    app.db.query("UPDATE run SET state = 'cancelled' WHERE id = ?1").run(run.id);
  });

  test("a pull no agent holds is refused with no_agent and shows no button", async () => {
    app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(pull.id, bob.id);
    try {
      const before = agentRuns();
      const refused = await proposeResolution(app, alice, repo, current());
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toBe("no_agent");
      expect(agentRuns()).toBe(before);
      expect(await resolvePage()).not.toContain("Ask the crew to fix it");
    } finally {
      app.db.query("UPDATE issue SET assignee_id = NULL WHERE id = ?1").run(pull.id);
    }
  });

  test("a closed pull is refused with not_open", async () => {
    const before = agentRuns();
    const refused = await proposeResolution(app, alice, repo, { ...current(), state: "closed" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("not_open");
    expect(agentRuns()).toBe(before);
  });

  test("the brief names the pull's real base, not main", async () => {
    const real = getPull(app.db, repo.id, pull.number)!;
    const agent = getAgentByName(app.db, "bot")!;
    const text = taskPrompt({
      agent,
      repo,
      issue: getIssueById(app.db, pull.id)!,
      pull: { ...real, baseBranch: "trunk" },
      branch: real.headBranch,
      forgeUrl: servers.url,
      isApp: false,
      resuming: false,
      reason: "resolve",
      comments: [],
      reviews: [],
      reviewComments: [],
      since: real.createdAt,
      resolution: "x",
    });
    expect(text).toContain("merge `trunk` into it");
    expect(text).toContain("with `trunk`");
    expect(text).not.toContain("`main`");
  });

  test("a resolve run that ends ok without pushing records no commit and is not the crew's", async () => {
    // The agent now reports success and pushes nothing; the pull still conflicts.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-2","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Looked, changed nothing.","total_cost_usd":0.01,"num_turns":1,"session_id":"fake-2","terminal_reason":"completed"}'
`,
    );
    const known = new Set(listRuns(app.db, repo.id, { kind: "agent" }).map((r) => r.id));
    const head = current().headOid;
    const res = await tap();
    expect(res.status).toBe(303);
    const run = await settled((r) => r.reason === "resolve" && !known.has(r.id));
    expect(run.state).toBe("ok");
    expect(run.commitOid).toBe("");
    expect(current().headOid).toBe(head);
    const page = await resolvePage();
    expect(page).not.toContain("committed as");
    expect(page).toContain("the crew did not push a resolution");
  }, 60_000);
});
