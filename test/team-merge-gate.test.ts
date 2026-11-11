/**
 * A named team's review gates the merge (#10080, #9930): `mergePull` refuses
 * `team_review_required`, with the one sentence, while a team with a crew
 * reviewer here has not approved the head; the owner's break-glass passes.
 * The pull page's merge box and the terminal's `m` say which team (#10081).
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { nameTeams } from "../src/actions/issue_teams.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mergeFailure } from "../src/web/pages/pull.ts";
import { createSession } from "../src/core/sessions.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { mergeState, pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";
import { tokenFor } from "./helpers/tokens.ts";

quietLogs();

const SENTENCE = "Waiting on Design's review. Nothing was merged.";

describe("a named team's review gates the merge", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let n = 0;
  const id = (name: string) => getUserByName(app.db, name)!.id;
  const fresh = (pull: Pull) => getPull(app.db, repo.id, pull.number)!;

  const push = async (branch: string) => {
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: `${branch} ${++n}`,
      files: [{ path: `${branch}.md`, content: `${n}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  };

  /** A pull whose body closes a fresh issue naming `teams`. */
  const pullNaming = async (teams: string[]): Promise<Pull> => {
    const issue = openIssue(app, alice, repo, { title: "A chart" });
    if (!issue.ok) throw new Error(issue.error);
    if (teams.length > 0) {
      const set = nameTeams(app, alice, repo, issue.value, teams);
      if (!set.ok) throw new Error(set.error);
    }
    const branch = `g${++n}`;
    await push(branch);
    const o = await openPull(app, alice, repo, {
      title: branch,
      body: `Closes #${issue.value.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const approve = (pull: Pull, by: string) =>
    submitReview(app.db, { issueId: pull.id, authorId: id(by), state: "approved", commitOid: fresh(pull).headOid });
  const land = (pull: Pull, opts: { pastGate?: boolean } = {}) =>
    mergePull(app, alice, repo, fresh(pull), "merge", undefined, opts);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-team-merge-gate-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["quill", "moss"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      addToCrew(app, alice, repo, name);
    }
    // quill reviews here; moss is on the crew but not as a reviewer.
    seatAs(app.db, repo.id, id("quill"), "reviewer");
    saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
    saveTeam(app.db, "security", { charter: "", dial: 0, members: [id("moss")] });
    servers = await serve(app);
  }, 120_000);

  afterAll(async () => {
    servers?.stop();
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
    await Bun.sleep(100);
    app?.close();
    if (dataDir !== "") await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }, 30_000);

  test("held while the team is awaited, with the one sentence", async () => {
    const pull = await pullNaming(["design"]);
    const held = await land(pull);
    expect(held.ok).toBe(false);
    if (held.ok) return;
    expect(held.error).toEqual({ kind: "team_review_required", teams: ["Design"] });
    // The MCP merge answers in these words, the page's.
    expect(mergeFailure(held.error)).toBe(SENTENCE);
    expect(fresh(pull).mergedAt).toBeNull();
  });

  test("the API answers team_review_required and the sentence", async () => {
    const pull = await pullNaming(["design"]);
    const res = await fetch(`${servers.url}/api/v1/repos/alice/garden/pulls/${pull.number}/merge`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(app, "alice", "rw")}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "team_review_required", message: SENTENCE, teams: ["Design"] });
    expect(fresh(pull).mergedAt).toBeNull();
  });

  test("lands once the team approves the head", async () => {
    const pull = await pullNaming(["design"]);
    approve(pull, "quill");
    const landed = await land(pull);
    expect(landed.ok).toBe(true);
    expect(fresh(pull).mergedAt).not.toBeNull();
  });

  test("an approval of an older head holds", async () => {
    const pull = await pullNaming(["design"]);
    approve(pull, "quill");
    await push(pull.headBranch);
    const held = await land(pull);
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.error).toEqual({ kind: "team_review_required", teams: ["Design"] });
    expect(fresh(pull).mergedAt).toBeNull();
  });

  test("a team with no reviewer here does not hold", async () => {
    const pull = await pullNaming(["security"]);
    const landed = await land(pull);
    expect(landed.ok).toBe(true);
  });

  test("the owner's break-glass passes", async () => {
    const pull = await pullNaming(["design"]);
    const landed = await land(pull, { pastGate: true });
    expect(landed.ok).toBe(true);
    expect(fresh(pull).mergedAt).not.toBeNull();
  });

  /** The pull's Files step, as alice reads it: the page that draws the merge box. */
  const page = async (pull: Pull): Promise<string> => {
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const res = await fetch(`${servers.url}/alice/garden/pulls/${pull.number}/files`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return res.text();
  };
  const mergeButton = (body: string): string =>
    body.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Merge pull request/)?.[0] ?? "";

  test("the page's merge box names the team and disables merge while it holds", async () => {
    const pull = await pullNaming(["design"]);
    const held = await page(pull);
    expect(held).toContain("Waiting on Design&#39;s review.");
    expect(mergeButton(held)).toMatch(/\bdisabled\b/);
    approve(pull, "quill");
    const free = await page(pull);
    expect(free).not.toContain("Waiting on Design&#39;s review.");
  });

  test("the terminal's m says the sentence and does not merge", async () => {
    const pull = await pullNaming(["design"]);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
      { terminal: headlessTerminal(160, 44), exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Waiting on Design's review");
      tui.dispatch({ type: "key", key: "m", ctrl: false, alt: false, shift: false });
      await settleApp(tui);
      expect(tui.screen.toText()).toContain(SENTENCE);
      expect(fresh(pull).mergedAt).toBeNull();
    } finally {
      tui.stop();
    }
  });

  test("the terminal's merge state: a held team after the reviewers, before the checks", () => {
    const issue = { state: "open" } as Parameters<typeof mergeState>[0];
    const facts = { mergedAt: null, mergeable: true, diff: null } as unknown as Parameters<typeof mergeState>[1];
    expect(mergeState(issue, facts, false, false, true, true)).toBe("team_required");
    expect(mergeState(issue, facts, false, true, false, true)).toBe("review_required");
    expect(mergeState(issue, facts, false, false, false, false)).toBe("ready");
  });
});
