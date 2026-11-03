/**
 * A squash keeps the `Co-authored-by` trailers of the commits it folds (#9133):
 * #9096 landed Jay Moran's work as one commit that named only its lander.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { coAuthorLines, COAUTHORS_MAX, authorLinesBetween, creditsOf } from "../src/git/coauthors.ts";
import { runGitCapture } from "../src/git/env.ts";
import { serve } from "../src/http/server.ts";
import { forgetLive, readLandings } from "../src/release/landings.ts";
import { repoDir } from "../src/git/repos.ts";

const JAY = "Co-authored-by: Jay Moran <jmoran@espocorp.com>";

describe("coAuthorLines", () => {
  test("keeps well-formed trailers once per address, in order, and drops the rest", () => {
    const got = coAuthorLines([
      `Add it\n\n${JAY}\nco-authored-by: Ada <ada@x.dev>`,
      `More\n\nCo-authored-by: Jay M. <JMORAN@espocorp.com>\nCo-authored-by: no address\nCo-authored-by: <a@b.c>\nCo-authored-by: Eve <e@x.dev> trailing`,
    ]);
    expect(got).toEqual([JAY, "Co-authored-by: Ada <ada@x.dev>"]);
  });

  test("skips addresses already credited and caps the count", () => {
    expect(coAuthorLines([JAY], ["JMoran@espocorp.com"])).toEqual([]);
    const many = Array.from({ length: COAUTHORS_MAX + 5 }, (_, i) => `Co-authored-by: P${i} <p${i}@x.dev>`).join("\n");
    expect(coAuthorLines([many]).length).toBe(COAUTHORS_MAX);
  });
});

describe("authorLinesBetween", () => {
  test("credits a person who wrote a commit, not the crew's agents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-authors-"));
    try {
      const git = async (who: string, args: string[]) => {
        const p = Bun.spawn(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase().replace(" ", "")}@${who === "Scout" ? "agents.invalid" : "espocorp.com"}`, GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@x.dev" }, stdout: "pipe", stderr: "pipe" });
        return (await new Response(p.stdout).text()).trim();
      };
      await git("Scout", ["init", "-q", "-b", "main"]);
      await git("Scout", ["commit", "-q", "--allow-empty", "-m", "base"]);
      const base = await git("Scout", ["rev-parse", "HEAD"]);
      await git("Jay Moran", ["commit", "-q", "--allow-empty", "-m", "a"]);
      await git("Scout", ["commit", "-q", "--allow-empty", "-m", "b"]);
      const head = await git("Scout", ["rev-parse", "HEAD"]);
      expect(await authorLinesBetween(dir, base, head)).toEqual(["Co-authored-by: Jay Moran <jaymoran@espocorp.com>"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a squash landing", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-coauthors-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("user");
    alice = a.value;
    const made = await createRepo(app, alice, { name: "page", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "a.txt", content: "a\n" }] });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    addToCrew(app, alice, repo, "scout");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const land = async (slug: string, message: string, strategy: "squash" | "merge"): Promise<string> => {
    const branch = await commitToBranch(app, alice, repo, { branch: `feature/${slug}`, base: "main", message, files: [{ path: `${slug}.md`, content: `${slug}\n` }] });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, getUserByName(app.db, "scout")!, repo, { title: `Do ${slug}`, body: "Done.", baseBranch: "main", headBranch: `feature/${slug}` });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const merged = await mergePull(app, alice, repo, pull, strategy);
    if (!merged.ok) throw new Error(String(merged.error));
    const log = await runGitCapture(["log", "-1", "--format=%B", "main"], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) });
    return log.stdout;
  };

  test("keeps the Co-authored-by of the commits it folds, beside the lander's", async () => {
    const body = await land("squashed", `Add the page\n\n${JAY}`, "squash");
    expect(body).toContain(JAY);
    expect(body).toContain("Co-authored-by: alice <");
  });

  test("a squash whose commits name no one adds no one", async () => {
    const body = await land("plain", "Add the plain page", "squash");
    expect(body.match(/^Co-authored-by:/gm)?.length).toBe(1);
  });

  test("a pull cannot forge a trailer with a line break in a name", async () => {
    const body = await land("forged", "Add forged\n\nCo-authored-by: Mallory\nSigned-off-by: root <r@x.dev>", "squash");
    expect(body).not.toContain("Mallory");
  });

  /** A pull from `feature/<slug>` whose one commit is authored by `who`, landed as a squash; the landed message. */
  const landAuthoredBy = async (slug: string, who: { name: string; email: string }): Promise<string> => {
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    const tree = (await runGitCapture(["rev-parse", "main^{tree}"], { cwd: dir })).stdout.trim();
    const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: dir, stdin: new TextEncoder().encode(`${slug}\n`) }).stdout.toString().trim();
    const mk = Bun.spawnSync(["git", "mktree"], { cwd: dir, stdin: new TextEncoder().encode(`${Bun.spawnSync(["git", "ls-tree", tree], { cwd: dir }).stdout.toString()}100644 blob ${blob}\t${slug}.md\n`) }).stdout.toString().trim();
    const main = (await runGitCapture(["rev-parse", "main"], { cwd: dir })).stdout.trim();
    const commit = Bun.spawnSync(["git", "commit-tree", mk, "-p", main, "-m", `Add ${slug}`], { cwd: dir, env: { ...process.env, ...env } }).stdout.toString().trim();
    await runGitCapture(["update-ref", `refs/heads/feature/${slug}`, commit], { cwd: dir });
    const opened = await openPull(app, getUserByName(app.db, "scout")!, repo, { title: `Do ${slug}`, body: "Done.", baseBranch: "main", headBranch: `feature/${slug}` });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(app, alice, repo, getPull(app.db, repo.id, opened.value.number)!, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    return (await runGitCapture(["log", "-1", "--format=%B", "main"], { cwd: dir })).stdout;
  };

  test("a squash credits the person who authored its commit, and not an agent", async () => {
    const jay = await landAuthoredBy("by-jay", { name: "Jay Moran", email: "jmoran@espocorp.com" });
    expect(jay).toContain("Co-authored-by: Jay Moran <jmoran@espocorp.com>");
    const agent = await landAuthoredBy("by-agent", { name: "Scout", email: "scout@agents.invalid" });
    expect(agent).not.toContain("agents.invalid");
  });

  test("the changelog names Jay on his landing and no one on one without credit", async () => {
    app.config.forgeRepo = `${repo.ownerName}/${repo.name}`;
    await land("credited", `Add credited\n\n${JAY}`, "squash");
    await land("uncredited", "Add uncredited", "squash");
    const dir0 = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const was = process.env["FORGE_COMMIT"];
    process.env["FORGE_COMMIT"] = (await runGitCapture(["rev-parse", "main"], { cwd: dir0 })).stdout.trim();
    forgetLive();
    const read = await readLandings(app);
    const byTitle = (t: string) => [...read.live, ...read.onItsWay].find((l) => l.title === t)!;
    expect(byTitle("Do credited").with).toEqual(["Jay Moran"]);
    expect(byTitle("Do uncredited").with).toBeUndefined();
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const oid = (await runGitCapture(["rev-parse", "main"], { cwd: dir })).stdout.trim();
    expect((await creditsOf(dir, [oid])).get(oid)).toEqual([]);
    const server = await serve(app);
    try {
      const html = await (await fetch(`${server.url}/changelog`)).text();
      expect(html).toContain("with Jay Moran");
      // Three landed pulls carry Jay's credit (a trailer twice, an authorship once); the rest say nothing of it.
      expect(html.match(/with Jay Moran/g)?.length).toBe(3);
      const row = html.slice(html.indexOf("Do uncredited"));
      expect(row.slice(0, row.indexOf("</li>"))).not.toContain(" with ");
    } finally {
      server.stop();
      if (was === undefined) delete process.env["FORGE_COMMIT"];
      else process.env["FORGE_COMMIT"] = was;
      forgetLive();
    }
  });
});
