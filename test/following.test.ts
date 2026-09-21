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
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
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
import { forkRelation, type ForkRelation } from "../src/core/following.ts";
import { getIssueById, listIssues } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

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
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
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
    const e = await createUser(app.db, {
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
    expect(((await res.json()) as { files: string[] }).files).toEqual([
      "README.md",
    ]);
    const page = await fetch(`${base}/bob/game`, {
      headers: { authorization: `Bearer ${bobToken}`, accept: "text/html" },
    }).then((p) => p.text());
    expect(page).toContain("one file needs a decision: README.md");
    expect(page).toContain("Nobody is on the crew");
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

  test("a fork with autonomy on converges by itself when its parent moves", async () => {
    // A second follower, with a crew and autonomy on, and its own README.
    const c = await createUser(app.db, {
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
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
    const d = await createUser(app.db, {
      username: "dan",
      email: "dan@forge.local",
      password: "a-good-passphrase",
    });
    if (!d.ok) throw new Error(d.error);
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
});
