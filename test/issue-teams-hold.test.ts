/**
 * Which named teams still hold a pull (#10078, the first piece of #9930's
 * merge gate): a team with a crew reviewer and no current approval on the
 * head holds; a team with nobody to ask does not. Nothing calls it yet.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { nameTeams } from "../src/actions/issue_teams.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { teamsHolding } from "../src/core/issue_teams.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("teams holding a pull", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let repo: Repo;
  let n = 0;
  const id = (name: string) => getUserByName(app.db, name)!.id;
  const held = (pull: Pull) => teamsHolding(app.db, pull).map((v) => v.team);

  /** A pull whose body closes a fresh issue naming `teams`. */
  const pullNaming = async (teams: string[]): Promise<Pull> => {
    const issue = openIssue(app, alice, repo, { title: "A chart" });
    if (!issue.ok) throw new Error(issue.error);
    if (teams.length > 0) {
      const set = nameTeams(app, alice, repo, issue.value, teams);
      if (!set.ok) throw new Error(set.error);
    }
    const branch = `h${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title: branch,
      body: `Closes #${issue.value.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const approve = (pull: Pull, by: string, commitOid = pull.headOid) =>
    submitReview(app.db, { issueId: pull.id, authorId: id(by), state: "approved", commitOid });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-issue-teams-hold-"));
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
    for (const name of ["quill", "pike", "moss"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      addToCrew(app, alice, repo, name);
    }
    // quill and pike review here; moss is on the crew but not as a reviewer.
    seatAs(app.db, repo.id, id("quill"), "reviewer");
    seatAs(app.db, repo.id, id("pike"), "reviewer");
    saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
    saveTeam(app.db, "data-science", { charter: "", dial: 0, members: [id("pike")] });
    saveTeam(app.db, "security", { charter: "", dial: 0, members: [id("moss")] });
  }, 120_000);

  afterAll(async () => {
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
    await Bun.sleep(100);
    app?.close();
    if (dataDir !== "") await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }, 30_000);

  test("an awaited team holds, with its name", async () => {
    const pull = await pullNaming(["design", "data-science"]);
    expect(teamsHolding(app.db, pull).map((v) => [v.team, v.name])).toEqual([
      ["design", "Design"],
      ["data-science", "Data science"],
    ]);
  });

  test("an approval on the head clears that team, and only that team", async () => {
    const pull = await pullNaming(["design", "data-science"]);
    approve(pull, "quill");
    expect(held(pull)).toEqual(["data-science"]);
    approve(pull, "pike");
    expect(held(pull)).toEqual([]);
  });

  test("changes requested on the head holds", async () => {
    const pull = await pullNaming(["design"]);
    submitReview(app.db, { issueId: pull.id, authorId: id("quill"), state: "changes_requested", commitOid: pull.headOid });
    expect(held(pull)).toEqual(["design"]);
  });

  test("an approval on an older head holds", async () => {
    const pull = await pullNaming(["design"]);
    approve(pull, "quill");
    expect(held(pull)).toEqual([]);
    // A push moves the head past the approval.
    const moved = { ...pull, headOid: "f".repeat(40) };
    expect(held(moved)).toEqual(["design"]);
    expect(teamsHolding(app.db, moved)[0]!.stale).toBe(true);
  });

  test("a team with no crew reviewer here does not hold", async () => {
    const pull = await pullNaming(["security"]);
    expect(held(pull)).toEqual([]);
    const both = await pullNaming(["security", "design"]);
    expect(held(both)).toEqual(["design"]);
  });

  test("an issue that names no teams holds nothing", async () => {
    const pull = await pullNaming([]);
    expect(held(pull)).toEqual([]);
  });
});
