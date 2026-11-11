/**
 * The take pull's description (#2656): it lists the parent's new commits,
 * is rewritten when the parent moves again, and is left alone once a person
 * edited it. Local bare repositories, no network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setIssueState, updateIssueText } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { checkUpstream } from "../src/spawn/upstream.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args], { cwd });
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value.trim();
};

describe("the take pull's description", () => {
  let dir = "";
  let app: App;
  let repo: Repo;
  let parent = "";
  let work = "";

  const theirs = async (n: string, subject: string) => {
    await Bun.write(join(work, `${n}.txt`), n);
    await git(work, "add", ".");
    await git(work, "commit", "-m", subject);
    await git(work, "push", "-q", parent, "HEAD:refs/heads/main");
  };
  const open = () => listPulls(app.db, repo.id, { state: "open" }).filter((p) => p.headBranch === "forge/take-updates");
  const body = () => open()[0]!.body;
  const take = () => checkUpstream(app, { remote: parent });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-takebody-"));
    app = createApp({ dataDir: join(dir, "data"), url: "https://child.test", port: 0 });
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "kid", email: "kid@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const base = await commitToBranch(app, u.value, repo, { message: "base", files: [{ path: "a.txt", content: "base\n" }] });
    if (!base.ok) throw new Error(JSON.stringify(base.error));
    parent = join(dir, "parent.git");
    work = join(dir, "work");
    await git(dir, "clone", "-q", "--bare", repoDir(app.reposRoot, "kid", "forge"), parent);
    await git(dir, "clone", "-q", parent, work);
    // The fork has a commit of its own, so updates arrive as a pull.
    const own = await commitToBranch(app, u.value, repo, { message: "own", files: [{ path: "own.txt", content: "own\n" }] });
    if (!own.ok) throw new Error(JSON.stringify(own.error));
    await Bun.write(
      join(app.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: "https://parent.test",
        forgeCode: { repo: "kid/forge", upstream: "root/forge", mode: "take-updates", tip: "a".repeat(40), chain: [] },
      }),
    );
  }, 30_000);
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("3 commits are listed, newest first", async () => {
    for (const n of [1, 2, 3]) await theirs(`c${n}`, `subject ${n}`);
    await take();
    const b = body();
    expect(b.split("\n")[0]).toContain("3 new commits from root/forge");
    expect(b).toMatch(/\n[0-9a-f]{7,} \d{4}-\d\d-\d\d subject 3\n/);
    expect(b.indexOf("subject 3")).toBeLessThan(b.indexOf("subject 1"));
    expect(b).toContain("never merged for you");
  });

  test("2 more are fetched: the same pull's body lists 5", async () => {
    const number = open()[0]!.number;
    for (const n of [4, 5]) await theirs(`c${n}`, `subject ${n}`);
    await take();
    expect(open()).toHaveLength(1);
    expect(open()[0]!.number).toBe(number);
    const b = body();
    expect(b.split("\n")[0]).toContain("5 new commits");
    for (const n of [1, 2, 3, 4, 5]) expect(b).toContain(`subject ${n}\n`);
  });

  test("a body a person edited is kept", async () => {
    updateIssueText(app.db, open()[0]!.id, { body: "My own words." });
    await theirs("c6", "subject 6");
    await take();
    expect(body()).toBe("My own words.");
    expect((await git(repoDir(app.reposRoot, "kid", "forge"), "rev-list", "--parents", "-n1", open()[0]!.headOid)).split(" ")).toContain(await git(parent, "rev-parse", "refs/heads/main"));
  });

  test("hostile subjects stay inert in a fresh pull's body", async () => {
    setIssueState(app.db, open()[0]!.id, "closed", "dropped");
    await theirs("evil", "<script>alert(1)</script> [x](javascript:alert(1))");
    await take();
    expect(body()).toContain("<script>"); // the text is kept; rendering is what makes it inert
    const html = String(renderMarkdown(body()));
    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;");
  });
});
