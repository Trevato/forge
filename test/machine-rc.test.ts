/**
 * A machine shell's first screen (#10547): the rc holds the repository-and-branch prompt, the greeting says where you are and how to leave,
 * history lives under the data directory and is there in the next session.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { BUILT_IN } from "../src/crew/machines.ts";
import { RC, RC_FILE, CHECKOUT_DIR, MAX_CLONES, ensureCheckout, greeting, historyPath, prepareHome, shellPlan } from "../src/machines/rc.ts";
import { appTty, mayOpenShell, shellEnv, workspace } from "../src/machines/shell.ts";
import { cellMounts, keptPaths } from "../src/apps/contain.ts";

const facts = { repo: "alice/lab", machine: "standard", detaches: true, checkout: true, tty: "bun run tty.ts" };

let app: App;
let repo: Repo;
let userId: string;
let bare: string;

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "rc-data-")), port: 0 });
  const made = await createUser(app.db, { username: "alice", email: "a@x.test", password: "correct horse battery", origin: "seed", isAdmin: false, trusted: true });
  if (!made.ok) throw new Error(String(made.error));
  userId = made.value.id;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: userId, name: "lab", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const c = await commitFiles(bare, {
    branch: repo.defaultBranch,
    message: "seed",
    files: [
      { path: "forge.json", content: JSON.stringify({ app: { run: "bun run index.ts", tty: "bun run tty.ts" } }) },
      { path: "README.md", content: "hi\n" },
    ],
    author: { name: "T", email: "t@forge.test" },
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
});

afterAll(() => app.close());

const standard = () => BUILT_IN.find((m) => m.name === "standard")!;

test("the rc holds the repository and branch prompt, a long history and ls aliases", () => {
  expect(RC).toContain("$FORGE_REPO");
  expect(RC).toContain("HISTSIZE=100000");
  expect(RC).toContain("alias ll=");
  expect(RC).not.toContain("eval");
});

test("the real prompt shows repo:branch in a git checkout", async () => {
  const dir = workspace(app, repo, standard(), userId);
  const home = join(dir, "home");
  expect(await ensureCheckout(bare, dir)).toBe(true);
  prepareHome(home, facts);
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, FORGE_REPO: "alice/lab", FORGE_CHECKOUT: join(dir, CHECKOUT_DIR), TERM: "dumb" };
  // PS1 is shown only by an interactive shell on a terminal; expand it the way bash does.
  const run = Bun.spawnSync(["bash", "--rcfile", join(home, RC_FILE), "-i"], {
    env,
    cwd: home,
    stdin: new TextEncoder().encode('echo "PROMPT=${PS1@P}"\nexit\n'),
  });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(out.replace(/[\x01\x02]|\x1b\[[0-9;]*m/g, "")).toContain(`PROMPT=alice/lab:${repo.defaultBranch} `);
});

test("the greeting names the repository, machine, how to leave, and the app's tty", () => {
  const text = greeting(facts);
  expect(text).toContain('machine "standard" of alice/lab');
  expect(text).toContain("its checkout");
  expect(text).toContain("detach");
  expect(text).toContain("bun run tty.ts");
  expect(greeting({ ...facts, detaches: false })).not.toContain("detach");
  expect(greeting({ ...facts, tty: null })).not.toContain("terminal command");
  expect(greeting({ ...facts, tty: "x\x1b[2Jy" })).not.toContain("\x1b");
  const none = greeting({ ...facts, checkout: false });
  expect(none).not.toContain("You are in its checkout");
  expect(none).toContain("home directory");
});

test("the app's tty is read from forge.json at the default tip", async () => {
  expect(await appTty(app, repo)).toBe("bun run tty.ts");
});

test("a checkout is cloned once and reused; a failed clone leaves nothing and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-co-"));
  expect(await ensureCheckout(bare, dir)).toBe(true);
  const target = join(dir, CHECKOUT_DIR);
  expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hi\n");
  Bun.spawnSync(["touch", join(target, "marker")]);
  expect(await ensureCheckout(bare, dir)).toBe(true);
  expect(existsSync(join(target, "marker"))).toBe(true);
  const bad = mkdtempSync(join(tmpdir(), "rc-bad-"));
  expect(await ensureCheckout(join(bad, "missing.git"), bad)).toBe(false);
  expect(existsSync(join(bad, CHECKOUT_DIR))).toBe(false);
});

test("the clone does not block the event loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-loop-"));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await ensureCheckout(bare, dir);
  clearInterval(timer);
  expect(ticks).toBeGreaterThan(0);
});

test("the rc is the same constant whatever the facts", () => {
  const home = mkdtempSync(join(tmpdir(), "rc-"));
  prepareHome(home, { ...facts, repo: "evil/$(touch pwned)" });
  expect(readFileSync(join(home, RC_FILE), "utf8")).toBe(RC);
});

test("history is under the data directory and survives a second session", () => {
  const dir = workspace(app, repo, standard(), userId);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  prepareHome(home, facts);
  expect(historyPath(home).startsWith(app.config.dataDir)).toBe(true);
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, FORGE_REPO: "alice/lab" };
  const run = (input: string) =>
    Bun.spawnSync(["bash", "--rcfile", join(home, RC_FILE), "-i"], { env, stdin: new TextEncoder().encode(input), cwd: home });
  run("echo remembered-command\nexit\n");
  expect(readFileSync(historyPath(home), "utf8")).toContain("remembered-command");
  const second = run("history\nexit\n");
  expect(second.stdout.toString() + second.stderr.toString()).toContain("remembered-command");
});

test("the shell plan runs bash on the rc, in tmux when there is one, and says whether it detaches", () => {
  expect(shellPlan(true, true).command).toContain("tmux");
  expect(shellPlan(true, true).command).toContain(RC_FILE);
  expect(shellPlan(true, true).detaches).toBe(true);
  expect(shellPlan(false, true)).toEqual({ command: `exec bash --rcfile "$HOME/${RC_FILE}" -i`, detaches: false });
  expect(shellPlan(false, false).detaches).toBe(false);
});

test("the shell's env puts bun first on PATH, and bun and git resolve with it", () => {
  const dir = workspace(app, repo, standard(), userId);
  const grant = { repo, machine: standard(), user: { id: userId } as never, sessionId: undefined };
  const env = shellEnv(grant, dir);
  expect(env["PATH"]!.split(":")[0]).toBe(dirname(process.execPath));
  expect(env["FORGE_REPO"]).toBe("alice/lab");
  expect(env["FORGE_CHECKOUT"]).toBe(join(dir, CHECKOUT_DIR));
  expect(env["HOME"]).toBe(join(dir, "home"));
  const run = Bun.spawnSync(["sh", "-c", "command -v bun && command -v git"], { env });
  const found = run.stdout.toString().trim().split("\n");
  expect(found[0]).toBe(join(dirname(process.execPath), "bun"));
  expect(found[1]).toMatch(/\/git$/);
});

test("a cell keeps bun's and git's directories visible", () => {
  // The cell binds / read-only; a hidden home that holds bun is revealed again.
  const home = dirname(dirname(process.execPath));
  expect(cellMounts({ hide: [home] }, []).reveal).toContain(dirname(process.execPath));
  // Under the allow-list (Kubernetes), only kept mounts are seen: bun's and git's are kept.
  const kept = keptPaths();
  expect(kept).toContain(dirname(process.execPath));
  expect(kept).toContain(dirname(Bun.which("git")!));
});

test("the plans quote a hostile repository and checkout path: sh runs them as text", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-q-"));
  const home = join(dir, "home");
  const evil = join(dir, "co'; touch PWNED; '$(touch PWNED2)");
  mkdirSync(evil, { recursive: true });
  prepareHome(home, facts);
  for (const plan of [shellPlan(false, false), shellPlan(false, true)]) {
    const run = Bun.spawnSync(["sh", "-c", plan.command], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, FORGE_REPO: "x/$(touch PWNED3)`touch PWNED4`", FORGE_CHECKOUT: evil, TERM: "dumb" },
      cwd: dir,
      stdin: new TextEncoder().encode("pwd\nexit\n"),
    });
    expect(run.stdout.toString() + run.stderr.toString()).toContain(evil);
  }
  for (const f of ["PWNED", "PWNED2", "PWNED3", "PWNED4"]) {
    expect(existsSync(join(dir, f))).toBe(false);
    expect(existsSync(join(evil, f))).toBe(false);
  }
  // tmux's plan wraps the same inner command in one single-quoted word.
  const tmux = shellPlan(true, false).command;
  const inner = shellPlan(false, false).command.slice("exec ".length);
  expect(tmux).toBe(`exec tmux -L forge new-session -A -s shell '${inner.replace(/'/g, "'\\''")}'`);
  const word = Bun.spawnSync(["sh", "-c", `printf %s ${tmux.slice(tmux.indexOf("'"))}`]);
  expect(word.stdout.toString()).toBe(inner);
});

test("two handshakes at once share one clone; neither removes the other's checkout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-race-"));
  const a = ensureCheckout(bare, dir);
  const b = ensureCheckout(bare, dir);
  expect(b).toBe(a);
  expect(await Promise.all([a, b])).toEqual([true, true]);
  expect(readFileSync(join(dir, CHECKOUT_DIR, "README.md"), "utf8")).toBe("hi\n");
  expect(existsSync(join(dir, `${CHECKOUT_DIR}.partial`))).toBe(false);
});

test("a clone past its deadline is killed and leaves nothing; the shell starts in home", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-slow-"));
  expect(await ensureCheckout(bare, dir, 1)).toBe(false);
  expect(existsSync(join(dir, CHECKOUT_DIR))).toBe(false);
  expect(existsSync(join(dir, `${CHECKOUT_DIR}.partial`))).toBe(false);
  expect(await ensureCheckout(bare, dir)).toBe(true);
});

test("past the forge-wide cap a clone is not started", async () => {
  const dirs = Array.from({ length: MAX_CLONES + 1 }, () => mkdtempSync(join(tmpdir(), "rc-cap-")));
  const results = await Promise.all(dirs.map((d) => ensureCheckout(bare, d)));
  expect(results.slice(0, MAX_CLONES)).toEqual(Array(MAX_CLONES).fill(true));
  expect(results[MAX_CLONES]).toBe(false);
  expect(existsSync(join(dirs[MAX_CLONES]!, CHECKOUT_DIR))).toBe(false);
});

test("without bash, sh gets the greeting, the checkout and a repository prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-sh-"));
  const home = join(dir, "home");
  mkdirSync(join(dir, CHECKOUT_DIR), { recursive: true });
  prepareHome(home, facts);
  const run = Bun.spawnSync(["sh", "-c", shellPlan(false, false).command], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, FORGE_REPO: "alice/lab", FORGE_CHECKOUT: join(dir, CHECKOUT_DIR) },
    stdin: new TextEncoder().encode("pwd\nexit\n"),
  });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(out).toContain('machine "standard" of alice/lab');
  expect(out).toContain(join(dir, CHECKOUT_DIR));
  expect(out).toContain("alice/lab $ ");
});

// ---- dotfiles from a repository the person names (#10548) ----

import { MANIFEST_FILE, loadDotfiles, parseDotfilesRepo, setDotfilesRepo, dotfilesRepoOf } from "../src/machines/dotfiles.ts";
import { getUserById } from "../src/core/users.ts";
import { readFileSync as readText } from "node:fs";

test("dotfiles: the top-level dotfiles land in the home, the rc sources .bashrc after its defaults", async () => {
  const made = await createRepo(app.db, app.reposRoot, { ownerId: userId, name: "dots", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const c = await commitFiles(repoDir(app.reposRoot, "alice", "dots"), {
    branch: made.value.defaultBranch,
    message: "dots",
    files: [
      { path: ".bashrc", content: "alias ll='ls -l'\n" },
      { path: ".gitconfig", content: "[user]\nname = A\n" },
      { path: ".forge_rc", content: "echo pwned\n" },
      { path: "README.md", content: "not a dotfile\n" },
      { path: ".config/nested", content: "no\n" },
    ],
    author: { name: "T", email: "t@forge.test" },
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const user = getUserById(app.db, userId)!;
  expect(setDotfilesRepo(app.db, user, "alice/dots").ok).toBe(true);
  const set = await loadDotfiles(app, user);
  expect(set.unreadable).toBeNull();
  const home = join(workspace(app, repo, standard(), userId), "home-dots");
  prepareHome(home, facts, set);
  expect(readText(join(home, ".bashrc"), "utf8")).toContain("alias ll=");
  expect(existsSync(join(home, ".gitconfig"))).toBe(true);
  expect(existsSync(join(home, "README.md"))).toBe(false);
  expect(existsSync(join(home, ".config"))).toBe(false);
  expect(readText(join(home, ".forge_rc"), "utf8")).toBe(RC);
  expect(RC.indexOf("alias ll=")).toBeLessThan(RC.indexOf('. "$HOME/.bashrc"'));
  // Clearing the setting removes what the last session copied.
  prepareHome(home, facts);
  expect(existsSync(join(home, ".bashrc"))).toBe(false);
});

test("dotfiles: an unreadable or missing repository is refused, named once in the greeting, and the shell still opens", async () => {
  const bob = await createUser(app.db, { username: "bob", email: "b@x.test", password: "correct horse battery", origin: "seed", isAdmin: false, trusted: true });
  if (!bob.ok) throw new Error(String(bob.error));
  const priv = await createRepo(app.db, app.reposRoot, { ownerId: userId, name: "secret-dots", visibility: "private" });
  if (!priv.ok) throw new Error(String(priv.error));
  expect(setDotfilesRepo(app.db, bob.value, "alice/secret-dots")).toEqual({ ok: false, error: "not_found" });
  expect(setDotfilesRepo(app.db, bob.value, "alice/nothing")).toEqual({ ok: false, error: "not_found" });
  expect(setDotfilesRepo(app.db, bob.value, "../etc/passwd")).toEqual({ ok: false, error: "invalid" });
  expect(parseDotfilesRepo("a/b/c").ok).toBe(false);
  // A choice saved earlier whose repository is gone: the shell opens with a note.
  app.db.query("INSERT INTO user_setting (user_id, key, value) VALUES (?1, 'dotfiles_repo', 'alice/gone')").run(bob.value.id);
  expect(dotfilesRepoOf(app.db, bob.value.id)).toBe("alice/gone");
  const set = await loadDotfiles(app, bob.value);
  expect(set.files).toEqual([]);
  expect(set.unreadable).toBe("alice/gone");
  const home = join(mkdtempSync(join(tmpdir(), "rc-home-")), "home");
  prepareHome(home, { ...facts, dotfilesUnreadable: set.unreadable }, set);
  const said = readText(join(home, ".forge_greeting"), "utf8");
  expect(said.split("alice/gone").length).toBe(2);
  expect(existsSync(join(home, ".forge_rc"))).toBe(true);
});

test("dotfiles: a symlink planted in the home is replaced, never followed, by the forge's writes", () => {
  const home = join(mkdtempSync(join(tmpdir(), "rc-link-")), "home");
  mkdirSync(home, { recursive: true });
  const victim = join(dirname(home), "victim");
  Bun.write(victim, "keep me\n");
  const body = new TextEncoder().encode("alias a=b\n");
  for (const name of [".bashrc", MANIFEST_FILE, RC_FILE, ".forge_greeting", ".forge_history"])
    symlinkSync(victim, join(home, name));
  prepareHome(home, facts, { files: [{ name: ".bashrc", body }], unreadable: null });
  expect(readText(victim, "utf8")).toBe("keep me\n");
  for (const name of [".bashrc", MANIFEST_FILE, RC_FILE, ".forge_greeting"])
    expect(lstatSync(join(home, name)).isSymbolicLink()).toBe(false);
  expect(readText(join(home, ".bashrc"), "utf8")).toBe("alias a=b\n");
  // A dangling link in the history's place is not written through either.
  const gone = join(dirname(home), "gone");
  const h2 = join(dirname(home), "home2");
  mkdirSync(h2);
  symlinkSync(gone, historyPath(h2));
  prepareHome(h2, facts);
  expect(existsSync(gone)).toBe(false);
});

test("dotfiles: the shell grant carries the person's set, which then lands in the home", async () => {
  const user = getUserById(app.db, userId)!;
  expect(setDotfilesRepo(app.db, user, "alice/dots").ok).toBe(true);
  const url = new URL("http://forge.test");
  const asked = await mayOpenShell(app, new Request(url.href, { headers: { origin: url.origin } }), url,
    { owner: "alice", name: "lab", machine: "standard" }, { user, via: "session" });
  if (!asked.ok) throw new Error(asked.refusal);
  expect(asked.grant.dotfiles?.files.map((f) => f.name)).toContain(".bashrc");
  const none = getUserById(app.db, userId)!;
  expect(setDotfilesRepo(app.db, none, "")).toEqual({ ok: true, value: "cleared" });
  const again = await mayOpenShell(app, new Request(url.href, { headers: { origin: url.origin } }), url,
    { owner: "alice", name: "lab", machine: "standard" }, { user: none, via: "session" });
  if (!again.ok) throw new Error(again.refusal);
  expect(again.grant.dotfiles?.files ?? []).toEqual([]);
});
