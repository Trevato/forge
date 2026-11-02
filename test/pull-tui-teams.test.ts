/**
 * The terminal's pull screen names the team that still owes a review (#2897),
 * as the web pull page's team card does.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { nameTeams } from "../src/actions/issue_teams.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {} from "../src/core/agents.ts";
import { getPull } from "../src/core/pulls.ts";
import { submitReview } from "../src/core/reviews.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-teams-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a two-team issue shows one team approved and one awaited; no team shows nothing", async () => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice: User = made.value;
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const repo = r.value;
  const id = (name: string) => getUserByName(app.db, name)!.id;
  for (const name of ["quill", "pike"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(app, alice, repo, name);
    seatAs(app.db, repo.id, id(name), "reviewer");
  }
  saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
  saveTeam(app.db, "data-science", { charter: "", dial: 0, members: [id("pike")] });
  const seed = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "main",
    files: [{ path: "code.txt", content: "main" }],
  });
  if (!seed.ok) throw new Error(JSON.stringify(seed.error));

  let n = 0;
  const pullNaming = async (teams: string[]) => {
    const issue = openIssue(app, alice, repo, { title: "Chart" });
    if (!issue.ok) throw new Error(issue.error);
    const set = nameTeams(app, alice, repo, issue.value, teams);
    if (!set.ok) throw new Error(set.error);
    const branch = `b${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title: `Pull ${branch}`,
      body: `Closes #${issue.value.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return getPull(app.db, repo.id, o.value.number)!;
  };

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
  const show = async (number: number): Promise<string> => {
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), number));
    await settleApp(tui);
    return tui.screen.toText();
  };
  try {
    const two = await pullNaming(["design", "data-science"]);
    submitReview(app.db, {
      issueId: two.id,
      authorId: id("quill"),
      state: "approved",
      commitOid: two.headOid,
    });
    const text = await show(two.number);
    expect(text).toContain("Design: approved by quill");
    expect(text).toContain("Data science: awaited");

    submitReview(app.db, {
      issueId: two.id,
      authorId: id("pike"),
      state: "changes_requested",
      commitOid: two.headOid,
    });
    expect(await show(two.number)).toContain(
      "Data science: changes requested by pike",
    );

    // A verdict passed on a head the pull has since left is said to be old.
    const moved = await pullNaming(["design"]);
    submitReview(app.db, {
      issueId: moved.id,
      authorId: id("quill"),
      state: "approved",
      commitOid: "0".repeat(40),
    });
    expect(await show(moved.number)).toContain(
      "Design: approved by quill (on an older head)",
    );

    const none = await pullNaming([]);
    const bare = await show(none.number);
    expect(bare).not.toContain("awaited");
    expect(bare).not.toContain("approved by");
  } finally {
    tui.stop();
  }
}, 60_000);
