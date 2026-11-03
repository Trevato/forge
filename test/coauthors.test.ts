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
import { coAuthorLines, COAUTHORS_MAX } from "../src/git/coauthors.ts";
import { runGitCapture } from "../src/git/env.ts";
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
});
