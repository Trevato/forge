/**
 * A fork that follows its parent: where it stands, read from git; taking
 * the parent's updates when git can do it alone; and the crew's part when
 * both sides changed the same file. The relationship is the fork's own
 * fact, so it comes out the same from the core, the JSON and the page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentUrlProblem, refreshIdle } from "../src/core/parent_releases.ts";
import { Session } from "../src/tui/session.ts";
import { releasesRow } from "../src/tui/screens/about.ts";
import { createApp, type App } from "../src/app.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { severForge } from "../src/actions/follow.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo } from "../src/core/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { relationOf, takeUpdates } from "../src/actions/forks.ts";
import {
  convergeFork,
  convergeState,
  convergeTitle,
  followDivergence,
} from "../src/crew/converge.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import type { Agent } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import {
  forkRelation,
  lineageOf,
  type ForkRelation,
} from "../src/core/following.ts";
import { getIssueById, listIssues } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("a fork that follows its parent", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let bobToken: string;
  let parent: Repo;
  let fork: Repo;
  let bot: Agent;

  const as = (t: string) => ({
    authorization: `Bearer ${t}`,
    "content-type": "application/json",
  });
  const fresh = (r: Repo): Repo => getRepoById(app.db, r.id)!;
  const commit = (who: User, repo: Repo, path: string, content: string) =>
    commitToBranch(app, who, repo, {
      message: `${who.username}: ${path}`,
      files: [{ path, content }],
    });
  /** Following happens on the bus after the push; wait for it to land. */
  async function settle(
    until: (r: ForkRelation) => boolean,
    ms = 5000,
  ): Promise<ForkRelation> {
    const start = Date.now();
    for (;;) {
      const r = await forkRelation(app, fresh(fork), fresh(parent));
      if (r !== undefined && until(r)) return r;
      if (Date.now() - start > ms)
        throw new Error(`not settled: ${JSON.stringify(r)}`);
      await Bun.sleep(40);
    }
  }
  const relation = () => forkRelation(app, fresh(fork), fresh(parent));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-following-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    promote(app.db, bob);
    bobToken = createToken(app.db, bob.id, "t", "rw").token;
    const made = await createRepo(app, alice, {
      name: "game",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    parent = made.value;
    const seeded = await commit(alice, parent, "README.md", "# game\n");
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const forked = await forkRepo(app, bob, parent);
    if (!forked.ok) throw new Error(String(forked.error));
    fork = forked.value;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a fresh fork is in step", async () => {
    const r = await relation();
    expect(r?.state).toBe("synced");
    expect(r?.behind).toBe(0);
    expect(r?.ahead).toBe(0);
    const res = await fetch(`${base}/api/v1/repos/bob/game/following`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { state: string; parent: string };
    expect(j.state).toBe("synced");
    expect(j.parent).toBe("alice/game");
  });

  test("the parent moving moves an untouched fork, silently", async () => {
    await commit(alice, parent, "levels/one.txt", "one\n");
    const r = await settle(
      (x) => x.state === "synced" && x.forkTip === x.parentTip,
    );
    expect(r.parentTip).toBe(
      (await resolveOid(
        repoDir(app.reposRoot, "alice", "game"),
        "refs/heads/main",
      ))!,
    );
    const diverged = listEvents(app.db, { repoId: fork.id }).filter(
      (e) => e.kind === "fork.diverged",
    );
    expect(diverged.length).toBe(0);
  });

  test("the fork's own work makes it ahead; the parent moving makes it diverged", async () => {
    await commit(bob, fork, "skins/neon.txt", "neon\n");
    let r = await relation();
    expect(r?.state).toBe("ahead");
    expect(r?.ahead).toBe(1);
    await commit(alice, parent, "levels/two.txt", "two\n");
    r = await settle((x) => x.state === "diverged");
    expect(r.behind).toBe(1);
    expect(r.ahead).toBe(1);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    // The fork was told, once.
    const start = Date.now();
    while (
      listEvents(app.db, { repoId: fork.id }).filter(
        (e) => e.kind === "fork.diverged",
      ).length === 0 &&
      Date.now() - start < 3000
    )
      await Bun.sleep(30);
    const told = listEvents(app.db, { repoId: fork.id }).filter(
      (e) => e.kind === "fork.diverged",
    );
    expect(told.length).toBe(1);
    expect(told[0]!.payload["parent"]).toBe("alice/game");
  });

  test("the page says so in one sentence, and offers to take the updates", async () => {
    const res = await fetch(`${base}/bob/game`, {
      headers: { authorization: `Bearer ${bobToken}`, accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("following");
    expect(page).toContain("1 behind and 1 of your own; they merge cleanly.");
    expect(page).toContain("Take updates");
    expect(page).not.toContain("Converge with the crew");
  });

  test("taking a clean merge lands a merge commit and the fork is ahead", async () => {
    const res = await fetch(`${base}/api/v1/repos/bob/game/following/take`, {
      method: "POST",
      headers: as(bobToken),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      updated: boolean;
      merged: boolean;
      to: string;
    };
    expect(j.updated).toBe(true);
    expect(j.merged).toBe(true);
    const r = await relation();
    expect(r?.state).toBe("ahead");
    expect(r?.behind).toBe(0);
    expect(r?.ahead).toBe(2); // neon, and the merge itself
    expect(r?.forkTip).toBe(j.to);
    // A reader who cannot write may look, not take. (Alice would: the
    // forge's first account is its admin.)
    const e = await createUser(app.db, { origin: "seed", trusted: true,
      username: "eve",
      email: "eve@forge.local",
      password: "a-good-passphrase",
    });
    if (!e.ok) throw new Error(e.error);
    const denied = await fetch(`${base}/api/v1/repos/bob/game/following/take`, {
      method: "POST",
      headers: as(createToken(app.db, e.value.id, "t", "rw").token),
    });
    expect(denied.status).toBe(403);
  });

  test("the same file on both sides is a decision, not a button", async () => {
    await commit(alice, parent, "README.md", "# game — by alice\n");
    await settle((x) => x.state === "diverged");
    await commit(bob, fork, "README.md", "# game — by bob\n");
    const r = await relation();
    expect(r?.state).toBe("diverged");
    expect(r?.clean).toBe(false);
    expect(r?.conflicts).toEqual(["README.md"]);
    const took = await takeUpdates(app, bob, fresh(fork));
    expect(took.ok).toBe(false);
    if (!took.ok && typeof took.error !== "string")
      expect(took.error).toEqual({ kind: "conflict", files: ["README.md"] });
    const res = await fetch(`${base}/api/v1/repos/bob/game/following/take`, {
      method: "POST",
      headers: as(bobToken),
    });
    expect(res.status).toBe(409);
    const said = (await res.json()) as { files: string[]; converge: string | null };
    expect(said.files).toEqual(["README.md"]);
    expect(said.converge).toBe("no_crew");
    const page = await fetch(`${base}/bob/game`, {
      headers: { authorization: `Bearer ${bobToken}`, accept: "text/html" },
    }).then((p) => p.text());
    expect(page).toContain("one file needs a decision: README.md");
    expect(page).toContain("Nobody is on the crew");
  });

  test("the page form refuses a reader who cannot write, and opens nothing", async () => {
    const eve = getUserByName(app.db, "eve")!;
    const before = listIssues(app.db, fork.id, { state: "open" }).length;
    const res = await fetch(`${base}/bob/game/following`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken(app.db, eve.id, "form", "rw").token}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "do=converge",
    });
    expect(res.status).toBe(422);
    expect(listIssues(app.db, fork.id, { state: "open" }).length).toBe(before);
  });

  test("without a crew, converging is refused honestly", async () => {
    const res = await fetch(
      `${base}/api/v1/repos/bob/game/following/converge`,
      {
        method: "POST",
        headers: as(bobToken),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { kind: string }).kind).toBe("no_crew");
  });

  test("with a crew, converging opens one issue, stages the parent, queues one run", async () => {
    const made = await createAgent(app, alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value;
    expect(addToCrew(app, bob, fresh(fork), "bot").ok).toBe(true);

    const res = await fetch(
      `${base}/api/v1/repos/bob/game/following/converge`,
      {
        method: "POST",
        headers: as(bobToken),
      },
    );
    expect(res.status).toBe(202);
    const j = (await res.json()) as {
      kind: string;
      issue: number;
      agent: string;
    };
    expect(j.kind).toBe("queued");
    expect(j.agent).toBe("bot");

    const issues = listIssues(app.db, fork.id, { state: "open" });
    const issue = issues.find((i) => i.title === convergeTitle(fresh(parent)));
    expect(issue).toBeDefined();
    expect(issue!.number).toBe(j.issue);
    expect(issue!.assigneeId).toBe(bot.user.id);
    expect(issue!.body).toContain("refs/following/main");
    expect(issue!.body).toContain("README.md");

    const runs = listRuns(app.db, fork.id, { kind: "agent", limit: 10 });
    expect(runs.length).toBe(1);
    expect(runs[0]!.reason).toBe("converge");
    expect(runs[0]!.state).toBe("queued");
    expect(runs[0]!.summary).toBe("parent moved: README.md");
    expect(runs[0]!.issueId).toBe(issue!.id);

    const staged = await resolveOid(
      repoDir(app.reposRoot, "bob", "game"),
      "refs/following/main",
    );
    const parentTip = await resolveOid(
      repoDir(app.reposRoot, "alice", "game"),
      "refs/heads/main",
    );
    expect(staged).toBe(parentTip!);

    // Asking again doubles nothing.
    const again = await fetch(
      `${base}/api/v1/repos/bob/game/following/converge`,
      {
        method: "POST",
        headers: as(bobToken),
      },
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { kind: string }).kind).toBe("working");
    expect(listRuns(app.db, fork.id, { kind: "agent", limit: 10 }).length).toBe(
      1,
    );
    expect(convergeState(app, fresh(fork), fresh(parent))?.kind).toBe(
      "working",
    );

    const shown = await fetch(`${base}/api/v1/repos/bob/game/following`).then(
      (r) => r.json() as Promise<{ converge: { kind: string; issue: number } }>,
    );
    expect(shown.converge.kind).toBe("working");
    expect(shown.converge.issue).toBe(issue!.number);
    const page = await fetch(`${base}/bob/game`, {
      headers: { authorization: `Bearer ${bobToken}`, accept: "text/html" },
    }).then((p) => p.text());
    expect(page).toContain("is converging it on");
    expect(page).toContain("converging");
  });

  test("the builder is told what to merge and how to report", async () => {
    const issue = listIssues(app.db, fork.id, { state: "open" }).find(
      (i) => i.title === convergeTitle(fresh(parent)),
    )!;
    const prompt = taskPrompt({
      agent: bot,
      repo: fresh(fork),
      issue,
      branch: "bot/1-take-updates",
      forgeUrl: base,
      isApp: false,
      resuming: false,
      reason: "converge",
      comments: [],
      reviews: [],
      reviewComments: [],
      since: issue.createdAt,
      conflictFiles: ["README.md"],
      following: { parent: "alice/game", branch: "main" },
    });
    expect(prompt).toContain("follows alice/game");
    expect(prompt).toContain(
      "git fetch origin refs/following/main && git merge FETCH_HEAD",
    );
    expect(prompt).toContain("README.md");
    expect(prompt).toContain(`Closes #${issue.number}`);
    expect(prompt).toContain("Never drop this repository's own work");
  });

  test("taking updates into a conflict tells the crew: the same issue, never a second", async () => {
    const issue = listIssues(app.db, fork.id, { state: "open" }).find(
      (i) => i.title === convergeTitle(fresh(parent)),
    );
    expect(issue).toBeDefined();
    const before = listIssues(app.db, fork.id, { state: "open" }).length;
    const res = await fetch(`${base}/bob/game/following`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobToken}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "do=take",
    });
    expect(res.status).toBe(422);
    const said = ((await res.json()) as { error: string }).error;
    expect(said).toContain("README.md");
    expect(said).toContain(`#${issue!.number}`);
    expect(listIssues(app.db, fork.id, { state: "open" }).length).toBe(before);
  });

  test("the API's take tells the crew the same way: the converge issue is named", async () => {
    const issue = listIssues(app.db, fork.id, { state: "open" }).find(
      (i) => i.title === convergeTitle(fresh(parent)),
    );
    const res = await fetch(`${base}/api/v1/repos/bob/game/following/take`, {
      method: "POST",
      headers: as(bobToken),
    });
    expect(res.status).toBe(409);
    const said = (await res.json()) as { issue: number | null; converge: string };
    expect(said.converge).toBe("working");
    expect(said.issue).toBe(issue!.number);
  });

  test("a fork with autonomy on converges by itself when its parent moves", async () => {
    // A second follower, with a crew and autonomy on, and its own README.
    const c = await createUser(app.db, { origin: "seed", trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
    promote(app.db, c.value);
    const forked = await forkRepo(app, c.value, fresh(parent), "game-carol");
    if (!forked.ok) throw new Error(String(forked.error));
    const carols = forked.value;
    expect(addToCrew(app, c.value, carols, "bot").ok).toBe(true);
    app.db
      .query(
        "UPDATE repo SET autonomy = 'assisted', autonomy_by = ?2 WHERE id = ?1",
      )
      .run(carols.id, c.value.id);
    await commit(c.value, carols, "README.md", "# game — by carol\n");
    const off = followDivergence(app);
    try {
      await commit(alice, parent, "README.md", "# game — by alice, again\n");
      const start = Date.now();
      let runs = listRuns(app.db, carols.id, { kind: "agent", limit: 10 });
      while (runs.length === 0 && Date.now() - start < 5000) {
        await Bun.sleep(40);
        runs = listRuns(app.db, carols.id, { kind: "agent", limit: 10 });
      }
      expect(runs.length).toBe(1);
      expect(runs[0]!.reason).toBe("converge");
      const issue = getIssueById(app.db, runs[0]!.issueId!);
      expect(issue?.title).toBe(convergeTitle(fresh(parent)));
      // Bob's fork, with autonomy off, was told and left alone.
      const bobRuns = listRuns(app.db, fork.id, { kind: "agent", limit: 10 });
      expect(bobRuns.length).toBe(1);
    } finally {
      off();
    }
  }, 20_000);

  test("a fork with autonomy on takes a clean merge by itself", async () => {
    const d = await createUser(app.db, { origin: "seed", trusted: true,
      username: "dan",
      email: "dan@forge.local",
      password: "a-good-passphrase",
    });
    if (!d.ok) throw new Error(d.error);
    promote(app.db, d.value);
    const forked = await forkRepo(app, d.value, fresh(parent), "game-dan");
    if (!forked.ok) throw new Error(String(forked.error));
    const dans = forked.value;
    app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1",
      )
      .run(dans.id, d.value.id);
    await commit(d.value, dans, "mods/dan.txt", "dan\n");
    const off = followDivergence(app);
    try {
      await commit(alice, parent, "levels/three.txt", "three\n");
      const start = Date.now();
      let r = await forkRelation(app, fresh(dans), fresh(parent));
      while (
        (r === undefined || r.state !== "ahead") &&
        Date.now() - start < 5000
      ) {
        await Bun.sleep(40);
        r = await forkRelation(app, fresh(dans), fresh(parent));
      }
      expect(r?.state).toBe("ahead");
      expect(r?.behind).toBe(0);
      expect(
        listRuns(app.db, dans.id, { kind: "agent", limit: 10 }).length,
      ).toBe(0);
    } finally {
      off();
    }
  }, 20_000);

  test("the family has a tab: on the parent with the count, on a fork without, on neither for a loner", async () => {
    const parentPage = await (await fetch(`${base}/alice/game`)).text();
    expect(parentPage).toMatch(
      /href="\/alice\/game\/forks"[\s\S]{0,700}Forks<span class="pill"\s*>\d+<\/span/,
    );
    const forkPage = await (await fetch(`${base}/bob/game`)).text();
    expect(forkPage).toContain('href="/bob/game/forks"');
    const loner = await createRepo(app, alice, {
      name: "alone",
      visibility: "public",
    });
    if (!loner.ok) throw new Error(String(loner.error));
    const lonerPage = await (await fetch(`${base}/alice/alone`)).text();
    expect(lonerPage).not.toContain('href="/alice/alone/forks"');
    // The forks page lights its own tab.
    const tree = await (await fetch(`${base}/alice/game/forks`)).text();
    expect(tree).toMatch(/href="\/alice\/game\/forks"\s+aria-current="page"/);
  });

  test("the forks page shows each fork's standing", async () => {
    const page = await fetch(`${base}/alice/game/forks`, {
      headers: { accept: "text/html" },
    }).then((p) => p.text());
    expect(page).toContain("bob/game");
    expect(page).toContain("diverged");
    expect(page).toContain("carol/game-carol");
    expect(page).toContain("dan/game-dan");
    expect(page).toContain("ahead");
  });

  test("a child forge says how many releases it is behind its parent, and a parent that is down leaves the page up", async () => {
    let mode: "ok" | "500" | "garbage" = "ok";
    let asked = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => {
        asked++;
        if (mode === "500") return new Response("boom", { status: 500 });
        if (mode === "garbage") return new Response("<html>not json");
        await gate;
        return Response.json({
          releases: [
            { name: "9.0.2 <b>x</b>", url: "http://127.0.0.1/r/2" },
            { name: "9.0.1", url: "http://127.0.0.1/r/1" },
            { name: "9.0.0", url: "http://127.0.0.1/r/0" },
            { name: "bad", url: "javascript:alert(1)" },
          ],
        });
      },
    });
    const config = app.config as { parentUrl?: string; parentLoopback?: boolean };
    const cache = join(dataDir, "parent-releases.json");
    const was = process.env.FORGE_VERSION;
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const get = () =>
      fetch(`${base}/bob/game`, {
        headers: { authorization: `Bearer ${bobToken}`, accept: "text/html" },
      });
    const page = async () => flat(await (await get()).text());
    try {
      process.env.FORGE_VERSION = "9.0.0";
      config.parentUrl = `http://127.0.0.1:${fake.port}`;
      config.parentLoopback = true;

      // The first view does not wait for the parent: it answers while the
      // fake parent is still blocked on `gate`.
      const first = await page();
      expect(first).toContain("Checking 127.0.0.1:");
      open();
      await settled(dataDir);
      const ok = await page();
      expect(ok).toContain("2 releases behind");
      // The agent door carries the same view.
      const api = (await (
        await fetch(`${base}/api/v1/repos/bob/game/following`, {
          headers: { authorization: `Bearer ${bobToken}` },
        })
      ).json()) as {
        parentForge: {
          behind: number;
          host: string;
          down: boolean;
          releases: { name: string }[];
        };
      };
      expect(api.parentForge.behind).toBe(2);
      expect(api.parentForge.host).toBe(`127.0.0.1:${fake.port}`);
      expect(api.parentForge.down).toBe(false);
      expect(api.parentForge.releases.map((r) => r.name)).toEqual([
        "9.0.2 <b>x</b>",
        "9.0.1",
      ]);
      expect(ok).toContain("9.0.2 &lt;b&gt;x&lt;/b&gt;");
      expect(ok).not.toContain("<b>x</b>");
      expect(ok).not.toContain("javascript:");

      // Cached for ten minutes: the parent going away changes nothing yet.
      mode = "500";
      const before = asked;
      expect(await page()).toContain("2 releases behind");
      await settled(dataDir);
      expect(asked).toBe(before);

      // Past the cache the page is served from the old copy at once, the
      // refresh fails behind it, and the next view says so with the age.
      const stored = JSON.parse(await Bun.file(cache).text());
      stored.fetchedAt -= 3 * 3_600_000;
      stored.triedAt -= 3 * 3_600_000;
      await Bun.write(cache, JSON.stringify(stored));
      expect(await page()).toContain("2 releases behind");
      await settled(dataDir);
      const down = await page();
      expect(down).toContain("2 releases behind");
      expect(down).toContain(
        "could not be reached; this is a copy from 3 hours ago",
      );

      mode = "garbage";
      stored.triedAt -= 3_600_000;
      await Bun.write(cache, JSON.stringify(stored));
      expect((await get()).status).toBe(200);
      await settled(dataDir);
      expect(await page()).toContain("could not be reached");

      // A build the parent does not list is not "behind" by any count.
      process.env.FORGE_VERSION = "1.2.3";
      expect(await page()).toContain(
        "This version (1.2.3) is not in 127.0.0.1:",
      );

      // No copy at all: still a page, and an honest sentence.
      mode = "500";
      await Bun.write(cache, "{}");
      expect((await get()).status).toBe(200);
      await settled(dataDir);
      const none = await get();
      expect(none.status).toBe(200);
      expect(flat(await none.text())).toContain("could not be reached.");
    } finally {
      if (was === undefined) delete process.env.FORGE_VERSION;
      else process.env.FORGE_VERSION = was;
      delete config.parentUrl;
      delete config.parentLoopback;
      fake.stop(true);
    }
  });

  test("the terminal's About card says the same sentence from the same cache", async () => {
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          releases: [
            { name: "8.0.1", url: "http://127.0.0.1/r/1" },
            { name: "8.0.0", url: "http://127.0.0.1/r/0" },
          ],
        }),
    });
    const config = app.config as { parentUrl?: string; parentLoopback?: boolean };
    const was = process.env.FORGE_VERSION;
    try {
      process.env.FORGE_VERSION = "8.0.0";
      config.parentUrl = `http://127.0.0.1:${fake.port}`;
      config.parentLoopback = true;
      const session = new Session(app, {
        sshUsername: "bob",
        remoteAddress: "127.0.0.1",
        fingerprint: "SHA256:test",
        user: bob,
      });
      const repo = fresh(fork);
      expect(releasesRow(session, undefined)).toEqual([]);
      expect(releasesRow(session, fresh(parent))).toEqual([]);
      expect(releasesRow(session, repo)[0]![1]).toStartWith("Checking ");
      await settled(dataDir);
      expect(releasesRow(session, repo)).toEqual([
        ["releases", `1 release behind 127.0.0.1:${fake.port}.`],
      ]);
    } finally {
      if (was === undefined) delete process.env.FORGE_VERSION;
      else process.env.FORGE_VERSION = was;
      delete config.parentUrl;
      delete config.parentLoopback;
      fake.stop(true);
    }
  });

  test("the family is a tree: a fork of a fork nests under it, from any page in it", async () => {
    const f = await createUser(app.db, { origin: "seed", trusted: true,
      username: "fay",
      email: "fay@forge.local",
      password: "a-good-passphrase",
    });
    if (!f.ok) throw new Error(f.error);
    promote(app.db, f.value);
    const grand = await forkRepo(app, f.value, fresh(fork), "game-fay");
    if (!grand.ok) throw new Error(String(grand.error));

    const tree = await lineageOf(app, fresh(fork), () => true);
    expect(tree.root.repo.id).toBe(parent.id); // up to the oldest ancestor
    const bobs = tree.root.children.find((c) => c.repo.id === fork.id)!;
    expect(bobs.relation?.state).toBe("diverged");
    expect(
      bobs.children.map((c) => `${c.repo.ownerName}/${c.repo.name}`),
    ).toEqual(["fay/game-fay"]);
    expect(bobs.children[0]!.relation?.state).toBe("synced");
    expect(tree.size).toBe(5); // alice, bob, carol, dan, fay
    expect(tree.truncated).toBe(false);

    // The same tree from the root's page and from the middle's, with the
    // page you are on marked, and the grandchild inside its parent's list.
    for (const [path, here] of [
      ["/alice/game/forks", "alice/game"],
      ["/bob/game/forks", "bob/game"],
    ] as const) {
      const page = await fetch(`${base}${path}`, {
        headers: { accept: "text/html" },
      }).then((p) => p.text());
      expect(page).toContain("fay/game-fay");
      expect(page).toMatch(
        new RegExp(
          `aria-current="page"[\\s\\S]{0,2000}${here}[\\s\\S]{0,80}you are here`,
        ),
      );
      const bobAt = page.indexOf('href="/bob/game"');
      const nested = page.indexOf("lineage-children", bobAt);
      const fayAt = page.indexOf('href="/fay/game-fay"');
      expect(bobAt).toBeGreaterThan(-1);
      expect(nested).toBeGreaterThan(bobAt);
      expect(fayAt).toBeGreaterThan(nested);
    }

    // A family member the viewer may not read is not in the viewer's tree.
    const blind = await lineageOf(
      app,
      fresh(fork),
      (r) => r.id !== grand.value.id,
    );
    expect(blind.size).toBe(4);
  });

  test("relationOf hides nothing from a reader and everything from a stranger", async () => {
    const r = await relationOf(app, undefined, fresh(fork));
    expect(r?.state).toBe("diverged");
    const priv = await createRepo(app, alice, {
      name: "secret",
      visibility: "private",
    });
    if (!priv.ok) throw new Error(String(priv.error));
    await commit(alice, priv.value, "x.txt", "x\n");
    const pf = await forkRepo(app, alice, priv.value, "secret-fork");
    if (!pf.ok) throw new Error(String(pf.error));
    expect(await relationOf(app, bob, pf.value)).toBeUndefined();
    expect(await relationOf(app, alice, pf.value)).toBeDefined();
  });

  test("the fork's own work is proposed upstream in one call, with the words taken from what landed", async () => {
    // Something lands on the fork as a pull of its own.
    const branch = await commitToBranch(app, bob, fork, {
      branch: "feature/glow",
      base: fork.defaultBranch,
      message: "Glow",
      files: [{ path: "glow.txt", content: "on\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, bob, fork, {
      title: "Glow in the dark",
      baseBranch: fork.defaultBranch,
      headBranch: "feature/glow",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const landed = await mergePull(app, bob, fork, opened.value, "squash");
    expect(landed.ok).toBe(true);

    const res = await fetch(`${base}/api/v1/repos/bob/game/following/propose`, {
      method: "POST",
      headers: as(bobToken),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      number: number;
      opened: boolean;
      changes: number;
      title: string;
    };
    expect(j.opened).toBe(true);
    expect(j.changes).toBe(1);
    expect(j.title).toBe("Glow in the dark");
    const { getPull } = await import("../src/core/pulls.ts");
    const upstream = getPull(app.db, parent.id, j.number)!;
    expect(upstream.headRepoId).toBe(fork.id);
    expect(upstream.headBranch).toBe(fork.defaultBranch);
    expect(upstream.body).toContain("- Glow in the dark (bob/game#");
    expect(upstream.body).toContain("proposed from bob/game's following card");

    // Pressed again, the same proposal comes back rather than a second one.
    const again = await fetch(
      `${base}/api/v1/repos/bob/game/following/propose`,
      {
        method: "POST",
        headers: as(bobToken),
      },
    );
    expect(again.status).toBe(200);
    const k = (await again.json()) as { number: number; opened: boolean };
    expect(k.opened).toBe(false);
    expect(k.number).toBe(j.number);

    // The card offers the way to it now, not another proposal.
    const page = await (
      await fetch(`${base}/bob/game`, { headers: as(bobToken) })
    ).text();
    expect(page).toContain("See the upstream proposal");
    expect(page).not.toContain('value="propose"');
  });

  test("a proposal names only what is actually ahead: work the parent already has is not listed again", async () => {
    // A clean pair of its own: the fixture's pair has diverged on purpose.
    const made = await createRepo(app, alice, { name: "lamp", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const lamp = made.value;
    await commit(alice, lamp, "README.md", "# lamp\n");
    const forked = await forkRepo(app, bob, lamp);
    if (!forked.ok) throw new Error(String(forked.error));
    const mine = forked.value;
    const land = async (title: string, file: string): Promise<void> => {
      const branch = await commitToBranch(app, bob, mine, {
        branch: `feature/${file}`,
        base: mine.defaultBranch,
        message: title,
        files: [{ path: `${file}.txt`, content: `${file}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, bob, mine, {
        title,
        baseBranch: mine.defaultBranch,
        headBranch: `feature/${file}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const landed = await mergePull(app, bob, mine, opened.value, "squash");
      if (!landed.ok) throw new Error(JSON.stringify(landed.error));
    };
    const propose = async () => {
      const res = await fetch(`${base}/api/v1/repos/bob/lamp/following/propose`, {
        method: "POST",
        headers: as(bobToken),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { number: number; changes: number; title: string };
    };
    const { getPull } = await import("../src/core/pulls.ts");

    await land("Glow in the dark", "glow");
    const first = await propose();
    expect(first.title).toBe("Glow in the dark");
    // The parent takes it, so Glow is upstream now.
    const standing = getPull(app.db, lamp.id, first.number)!;
    const taken = await mergePull(app, alice, lamp, standing, "merge");
    if (!taken.ok) throw new Error(JSON.stringify(taken.error));
    // The untouched fork follows that merge on the bus. Landing the next
    // pull before it has would race the follow's move of the same branch.
    const start = Date.now();
    for (;;) {
      const r = await forkRelation(app, fresh(mine), fresh(lamp));
      if (r?.state === "synced" && r.forkTip === r.parentTip) break;
      if (Date.now() - start > 5000)
        throw new Error(`not settled: ${JSON.stringify(r)}`);
      await Bun.sleep(40);
    }

    await land("Dim the lights", "dim");
    const second = await propose();
    expect(second.title).toBe("Dim the lights");
    expect(second.changes).toBe(1);
    const upstream = getPull(app.db, lamp.id, second.number)!;
    expect(upstream.body).toContain("- Dim the lights (bob/lamp#");
    expect(upstream.body).not.toContain("Glow in the dark");
  });
});

/**
 * A merge moves its base with `update-ref`, which runs no hook and announces
 * no push. Landing pulls is how a repository with a crew moves at all, so a
 * fork that followed pushes only would never follow anything.
 */
describe("a landed pull moves the forks, like the push it amounts to", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let carol: User;
  let parent: Repo;
  let untouched: Repo;
  let worked: Repo;
  let checks: ChecksHandle;

  const tip = (r: Repo) =>
    resolveOid(
      repoDir(app.reposRoot, r.ownerName, r.name),
      `refs/heads/${r.defaultBranch}`,
    );
  async function until(what: () => Promise<boolean> | boolean, ms = 5000) {
    const start = Date.now();
    while (!(await what())) {
      if (Date.now() - start > ms) throw new Error("not settled");
      await Bun.sleep(40);
    }
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-following-merge-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    const people: User[] = [];
    for (const username of ["alice", "bob", "carol"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, bob, carol] = people as [User, User, User];
    promote(app.db, bob, carol);
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    parent = made.value;
    const seeded = await commitToBranch(app, alice, parent, {
      message: "seed",
      files: [
        { path: "README.md", content: "# engine\n" },
        {
          path: "forge.json",
          content: '{"check": {"run": "test -f README.md", "install": ""}}\n',
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const one = await forkRepo(app, bob, parent);
    const two = await forkRepo(app, carol, parent);
    if (!one.ok || !two.ok) throw new Error("fork");
    untouched = one.value;
    worked = two.value;
    const own = await commitToBranch(app, carol, worked, {
      message: "carol's own",
      files: [{ path: "mine.txt", content: "mine\n" }],
    });
    if (!own.ok) throw new Error(JSON.stringify(own.error));
  }, 30_000);

  afterAll(async () => {
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the untouched fork follows; the one with its own work is told", async () => {
    const branched = await commitToBranch(app, alice, parent, {
      branch: "feature",
      message: "feature",
      files: [{ path: "feature.txt", content: "yes\n" }],
    });
    expect(branched.ok).toBe(true);
    const pull = await openPull(app, alice, parent, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    const before = await tip(untouched);
    const mine = await tip(worked);

    const merged = await mergePull(app, alice, parent, pull.value, "merge");
    expect(merged.ok).toBe(true);
    // The land itself announced no push on the parent: what follows is
    // following the merge.
    expect(
      listEvents(app.db, { repoId: parent.id, limit: 50 }).filter(
        (e) => e.kind === "push" && e.payload["merged"] === undefined,
      ).length,
    ).toBe(2);

    const landed = await tip(parent);
    expect(landed).not.toBe(before);
    await until(async () => (await tip(untouched)) === landed);
    const followed = listEvents(app.db, { repoId: untouched.id, limit: 20 })
      .filter((e) => e.kind === "push")
      .map((e) => e.payload["followed"]);
    expect(followed).toContain("alice/engine");

    await until(() =>
      listEvents(app.db, { repoId: worked.id, limit: 20 }).some(
        (e) => e.kind === "fork.diverged",
      ),
    );
    // Its own work is exactly where carol left it.
    expect(await tip(worked)).toBe(mine);
  });

  test("a copy of the parent's commit is not checked again; own work is", () => {
    const checked = (r: Repo) =>
      listRuns(app.db, r.id, { kind: "check", limit: 50 }).length;
    expect(checked(untouched)).toBe(0);
    expect(checked(worked)).toBe(1);
    expect(checked(parent)).toBeGreaterThan(0);
  });
});

/** Waits for any background refresh of the cache to finish. */
async function settled(dir: string): Promise<void> {
  await refreshIdle(dir);
}

describe("a parent URL", () => {
  test("is https, without credentials", () => {
    expect(parentUrlProblem("https://parent.example")).toBeNull();
    expect(parentUrlProblem("http://parent.example")).not.toBeNull();
    expect(parentUrlProblem("https://u:p@parent.example")).not.toBeNull();
    expect(parentUrlProblem("nonsense")).not.toBeNull();
    expect(parentUrlProblem("http://127.0.0.1:1", true)).toBeNull();
  });
});

describe("an open chain page hears a sever", () => {
  let dir = "";
  let root: App;
  let child: App;
  let servers: Servers;
  let cookie = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-chain-live-"));
    root = createApp({ dataDir: dir, url: "https://root.test", port: 0, forgeRepo: "alice/forge-code" });
    const alice = await createUser(root.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
    if (!alice.ok) throw new Error("user");
    const made = await createRepo(root, alice.value, { name: "forge-code", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(root.reposRoot, "alice", "forge-code"), {
      branch: "main",
      message: "forge v1",
      files: [{ path: "README.md", content: "# forge\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    const host = "root.test";
    const spawned = await spawnForge(
      root,
      alice.value,
      { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host }),
        request: new Request(`https://${host}/x`, { method: "POST", headers: { origin: `https://${host}` } }),
        url: new URL(`https://${host}/x`),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    child = createApp({ dataDir: childDirOf(root, spawned.value.bodyId), url: "https://kid.test", port: 0 });
    servers = await serve(child);
    cookie = `forge_session=${createSession(child.db, getUserByName(child.db, "alice")!.id).token}`;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    child.close();
    root.close();
    await rm(dir, { recursive: true, force: true });
  });

  const chainPage = async () =>
    (await (await fetch(`${servers.url}/kid/forge/following`, { headers: { cookie } })).text()).replace(/\s+/g, " ");

  test("the page carries a live region for forge.severed, scoped to its repository", async () => {
    const page = await chainPage();
    expect(page).toContain('id="live-chain"');
    expect(page).toContain('data-live="forge.severed,forge.proposal,forge.follow_mode,forge.upstream,forge.updates_taken"');
    expect(page).toContain('data-live-repo="kid/forge"');
    expect(page).not.toContain("follows nothing since");
    expect(page).not.toMatch(/lineage(-children|-here)?\b/);
    expect(page).toContain('aria-label="Forges, root first"');
    expect(page).toContain("you are here");
    expect(page).toContain('action="/kid/forge/following/mode"');
  });

  test("a sever reaches the viewer's stream with the repo the region filters on, and a refetch shows it", async () => {
    const ctl = new AbortController();
    const res = await fetch(`${servers.url}/events`, {
      headers: { cookie },
      signal: ctl.signal,
    });
    const reader = res.body!.getReader();
    const owner = getUserByName(child.db, "alice")!;
    const cut = await severForge(child, owner, getRepo(child.db, "kid", "forge")!);
    expect(cut.ok).toBe(true);

    let seen = "";
    const dec = new TextDecoder();
    while (!seen.includes('"forge.severed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    ctl.abort();
    const line = seen.split("\n").find((l) => l.startsWith("data:") && l.includes("forge.severed"))!;
    const event = JSON.parse(line.slice(5));
    expect(event.kind).toBe("forge.severed");
    expect(event.repo).toBe("kid/forge");

    const page = await chainPage();
    expect(page).toContain("follows nothing since");
    expect(page).toContain('id="live-chain"');
    expect(page).not.toMatch(/lineage(-children|-here)?\b/);
    expect(page).toContain('aria-label="Forges, root first"');
    expect(page).toContain("you are here");
    expect(page).toContain('id="severed"');
  });
});
