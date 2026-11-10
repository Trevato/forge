/**
 * `newApp` with a `template`: the tip of a repository the caller can read is
 * copied; an unreadable, oversized or symlinked template is refused before a
 * repository exists.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_APP_ERRORS, newApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { TEMPLATE_ERRORS, TEMPLATE_MAX_BYTES, TEMPLATE_MAX_FILES } from "../src/apps/template_tip.ts";
import { createApp } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { readerFor } from "../src/git/read.ts";
import type { FileWrite } from "../src/git/write.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "forge-tpl-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, isAdmin = false) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@x.test`, isAdmin,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const admin = await mk("boss", true);
  const owner = await mk("giver");
  const taker = await mk("taker");
  for (const u of [owner, taker]) setRole(app, admin, u.username, "member");
  const template = async (
    name: string,
    visibility: "public" | "private",
    files: FileWrite[],
  ) => {
    const repo = await createRepo(app, owner, { name, visibility, description: "" });
    if (!repo.ok) throw new Error(repo.error);
    const done = await commitToBranch(app, owner, repo.value, { message: "t", files });
    if (!done.ok) throw new Error(String(done.error));
  };
  return { app, owner, taker, template };
}

test("a public template's tip is copied, modes kept", async () => {
  const { app, taker, template } = await world();
  await template("kit", "public", [
    { path: "README.md", content: "# kit\n" },
    { path: "bin/run.sh", content: "echo hi\n", mode: "100755" },
  ]);
  const made = await newApp(app, taker, { name: "mine", template: "giver/kit" });
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  const dir = repoDir(app.reposRoot, "taker", "mine");
  const readme = await readerFor(dir).object(`refs/heads/${made.value.repo.defaultBranch}:README.md`);
  expect(readme.ok && new TextDecoder().decode(readme.value.body)).toBe("# kit\n");
  const tree = Bun.spawnSync(["git", "ls-tree", "-r", `refs/heads/${made.value.repo.defaultBranch}`], { cwd: dir }).stdout.toString();
  expect(tree).toContain("100755 blob");
  expect(tree).toMatch(/^100755 blob \w+\tbin\/run\.sh$/m);
  expect(tree).toMatch(/^100644 blob \w+\tREADME\.md$/m);
  // Not the starter app.
  const starter = await readerFor(dir).stat(`refs/heads/${made.value.repo.defaultBranch}:src/server.ts`);
  expect(starter.ok).toBe(false);
});

test("a private template the caller cannot read answers as one that does not exist, and nothing is made", async () => {
  const { app, taker, template } = await world();
  await template("secret", "private", [{ path: "a.txt", content: "x" }]);
  const hidden = await newApp(app, taker, { name: "mine", template: "giver/secret" });
  const absent = await newApp(app, taker, { name: "mine", template: "giver/nothing" });
  expect(hidden).toEqual({ ok: false, error: "no_such_template" });
  expect(absent).toEqual(hidden);
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("a malformed template name is refused", async () => {
  const { app, taker } = await world();
  for (const template of ["x", "../a/b", "a/b/c", "a/b;rm"]) {
    const made = await newApp(app, taker, { name: "mine", template });
    expect(made).toEqual({ ok: false, error: "no_such_template" });
  }
});

test("a template over the file cap is refused", async () => {
  const { app, taker, template } = await world();
  const files: FileWrite[] = Array.from({ length: TEMPLATE_MAX_FILES + 1 }, (_, i) => ({
    path: `f/${i}.txt`, content: "x",
  }));
  await template("huge", "public", files);
  const made = await newApp(app, taker, { name: "mine", template: "giver/huge" });
  expect(made).toEqual({ ok: false, error: "template_too_big" });
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("a template file over the byte cap is refused", async () => {
  const { app, taker, template } = await world();
  await template("fat", "public", [{ path: "big.bin", content: new Uint8Array(600 * 1024) }]);
  const made = await newApp(app, taker, { name: "mine", template: "giver/fat" });
  expect(made).toEqual({ ok: false, error: "template_too_big" });
});

/** Commit one more tree entry of `mode` onto a template's default branch. */
async function addEntry(app: ReturnType<typeof createApp>, repoName: string, mode: string, oid: string, path: string) {
  const dir = repoDir(app.reposRoot, "giver", repoName);
  const git = (args: string[], env: Record<string, string> = {}, input?: string) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir, stdin: input === undefined ? "ignore" : new Blob([input]),
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", ...env },
    });
    return r.stdout.toString().trim();
  };
  const branch = getRepo(app.db, "giver", repoName)!.defaultBranch;
  const index = join(dir, "tmp-index");
  const env = { GIT_INDEX_FILE: index };
  git(["read-tree", `refs/heads/${branch}`], env);
  git(["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`], env);
  const tree = git(["write-tree"], env);
  const commit = git(["commit-tree", tree, "-p", `refs/heads/${branch}`, "-m", "entry"]);
  git(["update-ref", `refs/heads/${branch}`, commit]);
}

test("a template holding a symlink is refused", async () => {
  const { app, taker, template } = await world();
  await template("linky", "public", [{ path: "a.txt", content: "x" }]);
  const dir = repoDir(app.reposRoot, "giver", "linky");
  const target = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: dir, stdin: new Blob(["a.txt"]) }).stdout.toString().trim();
  await addEntry(app, "linky", "120000", target, "link");
  const made = await newApp(app, taker, { name: "mine", template: "giver/linky" });
  expect(made).toEqual({ ok: false, error: "template_has_symlink" });
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("a template holding a submodule is refused as unsupported", async () => {
  const { app, taker, template } = await world();
  await template("modular", "public", [{ path: "a.txt", content: "x" }]);
  await addEntry(app, "modular", "160000", "1".repeat(40), "vendor");
  const made = await newApp(app, taker, { name: "mine", template: "giver/modular" });
  expect(made).toEqual({ ok: false, error: "template_unsupported" });
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("a template over the total byte cap is refused though every file is under its own", async () => {
  const { app, taker, template } = await world();
  const each = 500 * 1024;
  const files: FileWrite[] = Array.from({ length: Math.ceil(TEMPLATE_MAX_BYTES / each) + 1 }, (_, i) => ({
    path: `blob${i}.bin`, content: `${i}`.repeat(each).slice(0, each),
  }));
  await template("heavy", "public", files);
  const made = await newApp(app, taker, { name: "mine", template: "giver/heavy" });
  expect(made).toEqual({ ok: false, error: "template_too_big" });
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("a template with no commits is refused as empty", async () => {
  const { app, owner, taker } = await world();
  const repo = await createRepo(app, owner, { name: "bare", visibility: "public", description: "" });
  expect(repo.ok).toBe(true);
  const made = await newApp(app, taker, { name: "mine", template: "giver/bare" });
  expect(made).toEqual({ ok: false, error: "template_empty" });
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("every refusal has words, and the too-big words name all three caps", () => {
  for (const code of Object.keys(TEMPLATE_ERRORS)) expect(NEW_APP_ERRORS[code]).toBeTruthy();
  expect(TEMPLATE_ERRORS.template_too_big).toContain(`${TEMPLATE_MAX_FILES} files`);
  expect(TEMPLATE_ERRORS.template_too_big).toContain("512 KiB a file");
  expect(TEMPLATE_ERRORS.template_too_big).toContain("4 MiB in all");
});
