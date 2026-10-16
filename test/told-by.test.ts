/**
 * Who told and who shipped: a change names the person whose words it answers
 * and the agent that wrote it, on its page, the board, the feed and the merge
 * commit — derived from the issue it closes, stored nowhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull, landingTrailers, toldBy } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("who told and who shipped", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let shipped: Repo;
  let cookie: string;

  const get = (path: string) =>
    fetch(`${servers.url}${path}`, { headers: { cookie } });

  /** A fresh issue from bob, answered by scout's pull: every test makes its own, so none depends on another's merge. */
  const answered = async (into: Repo, slug: string): Promise<number> => {
    const told = openIssue(app, bob, into, { title: `Make it ${slug}` });
    if (!told.ok) throw new Error(String(told.error));
    const branch = await commitToBranch(app, alice, into, {
      branch: `feature/${slug}`,
      base: "main",
      message: `Do ${slug}`,
      files: [{ path: `${slug}.md`, content: `${slug}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, getUserByName(app.db, "scout")!, into, {
      title: `Notes, ${slug}`,
      body: `Done.\n\nCloses #${told.value.number}`,
      baseBranch: "main",
      headBranch: `feature/${slug}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value.number;
  };

  /** A public app of alice's with a first commit: the feed shows one shipped line per app, so a merge gets an app of its own. */
  const seedRepo = async (name: string): Promise<Repo> => {
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: `{"name":"${name}","scripts":{"start":"bun run server.ts"}}\n`,
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, made.value, { slug: name });
    if (!enabled.ok) throw new Error(String(enabled.error));
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-toldby-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    repo = await seedRepo("notes");
    shipped = await seedRepo("shipped");
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    addToCrew(app, alice, repo, "scout");
    addToCrew(app, alice, shipped, "scout");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("toldBy is the person who wrote the issue it closes, nobody else", async () => {
    const number = await answered(repo, "told");
    const pull = getPull(app.db, repo.id, number)!;
    expect(toldBy(app.db, pull)).toBe("bob");
    expect(toldBy(app.db, { ...pull, body: "no issue here" })).toBeNull();
    expect(toldBy(app.db, { ...pull, body: "Closes #9999" })).toBeNull();
  });

  test("the pull's page names both, escaped", async () => {
    const number = await answered(repo, "page");
    const html = await (await get(`/alice/notes/pulls/${number}`)).text();
    expect(html).toContain("in answer to");
    expect(html).toMatch(/in answer to[\s\S]{0,200}bob/);
    expect(html).toContain("scout");
  });

  test("the feed item says who told", async () => {
    await answered(repo, "feed");
    const items = readFeed(app.db, alice, { limit: 100 }).items;
    expect(
      items.some((i) => i.reason.includes("Notes, feed") &&
          i.reason.includes("(told by bob, by scout)")),
    ).toBe(true);
  });

  test("the merge commit is the agent's, with both trailers; the board card says who told", async () => {
    const number = await answered(shipped, "merge");
    const pull = getPull(app.db, shipped.id, number)!;
    const merged = await mergePull(app, alice, shipped, pull, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    const log = Bun.spawnSync(
      ["git", "log", "-1", "--format=%an|%cn%n%B", "main"],
      { cwd: repoDir(app.reposRoot, "alice", "shipped") },
    ).stdout.toString();
    expect(log).toContain("scout|alice");
    expect(log).toContain("Requested-by: bob <bob@users.noreply.localhost>");
    expect(log).toContain("Co-authored-by: alice <alice@users.noreply.localhost>");

    const board = await (await get("/board")).text();
    expect(board).toContain("told by bob");
    expect(board).toContain("scout");
  });

  test("trailers are one line each, whatever a name holds", () => {
    const t = landingTrailers(
      { name: "evil\nCo-authored-by: x", email: "e@x" },
      { name: "a", email: "a@x" },
    );
    expect(t.split("\n")).toHaveLength(2);
  });
});
