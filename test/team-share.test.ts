/**
 * Teams at work (#2680): with design at 30%, design issues get about 30% of
 * builder starts over a simulated day; the planner is told which teams are owed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createLabel, setIssueLabels } from "../src/core/issues.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, listQueued } from "../src/core/runs.ts";
import { listTeams, saveTeam } from "../src/core/teams.ts";
import { fairOrder, owed, REST, sharesOf, byDials, teamOfIssues } from "../src/crew/team_share.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import type { Team } from "../src/core/teams.ts";
import type { Run } from "../src/core/runs.ts";

const team = (slug: string, dial: number): Team => ({ slug, name: slug, charter: "", dial, members: [] });
const run = (id: string, issueId: string): Run => ({ id, issueId }) as unknown as Run;

describe("fairOrder", () => {
  test("design at 30% gets about 30% of 100 starts, the rest keep FIFO", () => {
    const queued: Run[] = [];
    for (let i = 0; i < 200; i++) queued.push(run(`r${i}`, i % 10 < 8 ? `rest${i}` : `design${i}`));
    const group = (r: Run) => (r.issueId!.startsWith("design") ? "design" : REST);
    const shares = sharesOf([team("design", 30)]);
    const first = fairOrder(queued, group, shares, new Map()).slice(0, 100);
    const design = first.filter((r) => group(r) === "design").length;
    expect(design).toBeGreaterThanOrEqual(29);
    expect(design).toBeLessThanOrEqual(31);
    const rest = first.filter((r) => group(r) === REST).map((r) => r.id);
    expect(rest).toEqual([...rest].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  });

  test("all dials at zero keeps the queue order", () => {
    const queued = [run("a", "1"), run("b", "2"), run("c", "3")];
    const out = fairOrder(queued, () => REST, sharesOf([]), new Map());
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("a team with nothing queued does not block the rest", () => {
    const out = fairOrder([run("a", "1")], () => REST, sharesOf([team("design", 30)]), new Map());
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  test("starts already made count against the share", () => {
    const queued = [run("a", "x"), run("d", "design")];
    const group = (r: Run) => (r.issueId === "design" ? "design" : REST);
    const shares = sharesOf([team("design", 50)]);
    const out = fairOrder(queued, group, shares, new Map([["design", 5]]));
    expect(out[0]!.id).toBe("a");
  });
});

describe("with a database", () => {
  let dataDir: string;
  let app: App;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-share-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("byDials leaves the queue alone while every dial is zero", () => {
    const queued = [run("a", "1"), run("b", "2")];
    expect(byDials(app.db, queued)).toBe(queued);
  });

  test("a zero-dial team's label is not a lane: its issues count as unowned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-share3-"));
    const a = createApp({ dataDir: dir, port: 0 });
    try {
      const u = await createUser(a.db, { origin: "seed", trusted: true, username: "alice",
        email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
      if (!u.ok) throw new Error(u.error);
      const made = await createRepo(a, u.value, { name: "engine", visibility: "private" });
      if (!made.ok) throw new Error(String(made.error));
      const issue = openIssue(a, u.value, made.value, { title: "Hardening" });
      if (!issue.ok) throw new Error(String(issue.error));
      const label = createLabel(a.db, made.value.id, "security", "ef4444");
      if (!label.ok) throw new Error(label.error);
      setIssueLabels(a.db, issue.value.id, [label.value.id]);
      expect(teamOfIssues(a.db, [issue.value.id]).size).toBe(0);
      saveTeam(a.db, "security", { charter: "", dial: 10, members: [] });
      expect(teamOfIssues(a.db, [issue.value.id]).get(issue.value.id)).toBe("security");
      saveTeam(a.db, "security", { charter: "", dial: 0, members: [] });
      expect(teamOfIssues(a.db, [issue.value.id]).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("owed lists only teams above zero", () => {
    expect(owed(app.db, "none")).toEqual([]);
    expect(saveTeam(app.db, "design", { charter: "Owns looks.", dial: 30, members: [] }).ok).toBe(true);
    const list = owed(app.db, "none");
    expect(list.map((o) => o.team.slug)).toEqual(["design"]);
    expect(list[0]!.open).toBe(0);
    expect(listTeams(app.db).length).toBe(4);
  });
});

describe("the planner's task", () => {
  const input = (owedList: unknown[], role = "planner") =>
    ({
      role,
      agent: { user: { username: "bot" } },
      repo: { ownerName: "alice", name: "square", defaultBranch: "main" },
      issue: { number: 1, title: "Direction", body: "Build it", authorName: "alice" },
      reason: "assigned",
      comments: [],
      owed: owedList,
    }) as unknown as Parameters<typeof taskPrompt>[0];
  const one = [{ team: { slug: "design", dial: 30, charter: "Owns looks." }, open: 0, today: 0 }];

  test("names each team owed work, its dial and its charter", () => {
    const text = taskPrompt(input(one));
    expect(text).toContain("design (30% of builder starts): Owns looks.");
    expect(text).toContain("NONE READY");
    expect(text).toContain('"labels":["design"]');
  });

  test("a builder is told nothing of teams", () => {
    expect(taskPrompt(input(one, "builder"))).not.toContain("builder starts");
  });
});

describe("a simulated day on a real database", () => {
  test("design at 30%: about 30% of builder starts go to design issues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-share2-"));
    const a = createApp({ dataDir: dir, port: 0 });
    try {
      const u = await createUser(a.db, { origin: "seed", trusted: true, username: "alice",
        email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
      if (!u.ok) throw new Error(u.error);
      const made = await createRepo(a, u.value, { name: "engine", visibility: "private" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = made.value;
      expect(saveTeam(a.db, "design", { charter: "Looks.", dial: 30, members: [] }).ok).toBe(true);
      const label = createLabel(a.db, repo.id, "Design", "7c3aed");
      if (!label.ok) throw new Error(label.error);
      const queue = (n: number): Run[] => {
        const runs: Run[] = [];
        for (let i = 0; i < n; i++) {
          const issue = openIssue(a, u.value, repo, { title: `Task ${i}-${Math.random()}` });
          if (!issue.ok) throw new Error(String(issue.error));
          if (i % 2 === 0) setIssueLabels(a.db, issue.value.id, [label.value.id]);
          runs.push(createRun(a.db, { repoId: repo.id, kind: "agent", issueId: issue.value.id, actorId: u.value.id, reason: "assigned" }));
        }
        return runs;
      };
      queue(200);
      let design = 0;
      let total = 0;
      for (let tick = 0; tick < 100; tick++) {
        const [next] = byDials(a.db, listQueued(a.db, "agent", 50));
        claimRun(a.db, next!.id);
        total++;
        if (teamOfIssues(a.db, [next!.issueId!]).get(next!.issueId!) === "design") design++;
      }
      expect(total).toBe(100);
      expect(design).toBeGreaterThanOrEqual(28);
      expect(design).toBeLessThanOrEqual(32);
      expect(owed(a.db, repo.id)[0]!.open).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
