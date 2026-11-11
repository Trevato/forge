/**
 * A marked repository whose top-level folders each hold TEMPLATE.md and
 * template.json offers each folder; choosing one copies only that folder,
 * fills its literals, and never runs a script it holds.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { templateChoices } from "../src/apps/template_folders.ts";
import { createApp } from "../src/app.ts";
import { setTemplateMark } from "../src/core/app_templates.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { readerFor } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import type { FileWrite } from "../src/git/write.ts";
import { TEMPLATE_MAX_FILE_BYTES } from "../src/apps/template_tip.ts";
import { serve } from "../src/http/server.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { blank } from "../src/tui/screens/common.ts";
import { openNewApp } from "../src/tui/screens/newapp.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function world(files: FileWrite[]) {
  const dir = await mkdtemp(join(tmpdir(), "forge-tplf-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, isAdmin = false) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, isAdmin, password: "a-good-passphrase" });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const admin = await mk("boss", true);
  const owner = await mk("giver");
  const taker = await mk("taker");
  for (const u of [owner, taker]) setRole(app, admin, u.username, "member");
  const repo = await createRepo(app, owner, { name: "kits", visibility: "public", description: "" });
  if (!repo.ok) throw new Error(repo.error);
  const done = await commitToBranch(app, owner, repo.value, { message: "t", files });
  if (!done.ok) throw new Error(String(done.error));
  setTemplateMark(app.db, repo.value, true, admin.id);
  return { app, taker };
}

const cfg = (c: unknown): FileWrite => ({ path: "template.json", content: JSON.stringify(c) });
const two: FileWrite[] = [
  { path: "web/TEMPLATE.md", content: "# Web <b>kit</b>\n\nA small site.\n" },
  { path: "web/template.json", content: JSON.stringify({ files: ["README.md"], literals: ["{{name}}", "{{description}}"] }) },
  { path: "web/README.md", content: "# {{name}}\n{{description}}\n" },
  { path: "web/new.mjs", content: "throw new Error('ran');\n" },
  { path: "cli/TEMPLATE.md", content: "# CLI\nA tool.\n" },
  { path: "cli/template.json", content: "{}" },
  { path: "cli/main.ts", content: "console.log(1)\n" },
  { path: "other/TEMPLATE.md", content: "# No config\n" },
  { path: "other/a.txt", content: "x" },
];

test("a two-folder repository offers two templates, and not a folder missing template.json", async () => {
  const { app, taker } = await world(two);
  const choices = await templateChoices(app, taker);
  const mine = choices.filter((c) => c.value.startsWith("giver/kits"));
  expect(mine.map((c) => c.value).sort()).toEqual(["giver/kits/cli", "giver/kits/web"]);
  const web = mine.find((c) => c.value.endsWith("/web"))!;
  expect(web.title).toBe("Web <b>kit</b>"); // raw text; the page escapes it
  expect(web.line).toBe("A small site.");
});

test("choosing a folder copies only it, fills the literals, and never runs new.mjs", async () => {
  const { app, taker } = await world(two);
  const made = await newApp(app, taker, { name: "mine", description: "a <site>", template: "giver/kits/web" });
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  const dir = repoDir(app.reposRoot, "taker", "mine");
  const ref = `refs/heads/${made.value.repo.defaultBranch}`;
  const tree = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", ref], { cwd: dir }).stdout.toString().split("\n").filter(Boolean).sort();
  expect(tree).toEqual(["README.md", "TEMPLATE.md", "new.mjs", "template.json"]);
  const readme = await readerFor(dir).object(`${ref}:README.md`);
  expect(readme.ok && new TextDecoder().decode(readme.value.body)).toBe("# mine\na <site>\n");
  const script = await readerFor(dir).object(`${ref}:new.mjs`);
  expect(script.ok && new TextDecoder().decode(script.value.body)).toContain("throw new Error('ran')");
});

test("a ../ path in template.json is refused and nothing is made", async () => {
  for (const bad of [{ files: ["../x"] }, { files: ["/etc/passwd"] }, { files: ["missing.txt"] }, { literals: ["{{secret}}"] }]) {
    const { app, taker } = await world([
      { path: "k/TEMPLATE.md", content: "# K\n" },
      { ...cfg(bad), path: "k/template.json" },
      { path: "k/a.txt", content: "x" },
    ]);
    const made = await newApp(app, taker, { name: "mine", template: "giver/kits/k" });
    expect(made).toEqual({ ok: false, error: "template_invalid" });
    expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
  }
});

test("a folder that is not a template, or a bad folder name, is not found", async () => {
  const { app, taker } = await world(two);
  for (const t of ["giver/kits/other", "giver/kits/nope", "giver/kits/..", "giver/kits/a b"]) {
    expect(await newApp(app, taker, { name: "mine", template: t })).toEqual({ ok: false, error: "no_such_template" });
  }
});

const okCfg = JSON.stringify({ files: ["a.txt"], literals: [] });

test("a symlink inside the chosen folder is refused and nothing is made", async () => {
  const { app, taker } = await world([
    { path: "k/TEMPLATE.md", content: "# K\n" },
    { path: "k/template.json", content: okCfg },
    { path: "k/a.txt", content: "x" },
  ]);
  const dir = repoDir(app.reposRoot, "giver", "kits");
  const run = (args: string[], env: Record<string, string> = {}, input?: string) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir, stdin: input === undefined ? "ignore" : new Blob([input]),
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", ...env },
    }).stdout.toString().trim();
  const branch = getRepo(app.db, "giver", "kits")!.defaultBranch;
  const target = run(["hash-object", "-w", "--stdin"], {}, "a.txt");
  const env = { GIT_INDEX_FILE: join(dir, "tmp-index") };
  run(["read-tree", `refs/heads/${branch}`], env);
  run(["update-index", "--add", "--cacheinfo", `120000,${target},k/link`], env);
  const commit = run(["commit-tree", run(["write-tree"], env), "-p", `refs/heads/${branch}`, "-m", "l"]);
  run(["update-ref", `refs/heads/${branch}`, commit]);
  expect(await newApp(app, taker, { name: "mine", template: "giver/kits/k" })).toEqual({ ok: false, error: "template_has_symlink" });
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("a file over the cap inside the chosen folder is refused and nothing is made", async () => {
  const { app, taker } = await world([
    { path: "k/TEMPLATE.md", content: "# K\n" },
    { path: "k/template.json", content: okCfg },
    { path: "k/a.txt", content: "x" },
    { path: "k/big.bin", content: new Uint8Array(TEMPLATE_MAX_FILE_BYTES + 1) },
  ]);
  expect(await newApp(app, taker, { name: "mine", template: "giver/kits/k" })).toEqual({ ok: false, error: "template_too_big" });
  expect(getRepo(app.db, "taker", "mine")).toBeUndefined();
});

test("the API lists owner/name/folder, and the page escapes the title in the picker", async () => {
  const { app, taker } = await world([
    ...two,
    { path: "xss/TEMPLATE.md", content: "# <script>alert(1)</script>\n\nA <i>line</i>.\n" },
    { path: "xss/template.json", content: "{}" },
  ]);
  const servers = await serve(app);
  try {
    const token = tokenFor(app, taker.username, "rw");
    const listed = await (await fetch(`${servers.url}/api/v1/app-templates`, { headers: { authorization: `Bearer ${token}` } })).json() as { templates: string[] };
    expect(listed.templates.filter((t) => t.startsWith("giver/kits")).sort()).toEqual(["giver/kits/cli", "giver/kits/web", "giver/kits/xss"]);
    const cookie = (
      (await fetch(`${servers.url}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username: "taker", password: "a-good-passphrase" }),
        redirect: "manual",
      })).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const page = await (await fetch(`${servers.url}/apps/new`, { headers: { cookie } })).text();
    expect(page).toContain('value="giver/kits/web"');
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).not.toContain("<b>kit</b>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("Web &lt;b&gt;kit&lt;/b&gt;");
  } finally {
    servers.stop();
  }
});

test("the terminal's New app prompt lists the folders", async () => {
  const { app, taker } = await world(two);
  const terminal = headlessTerminal(160, 30);
  const { app: tui, session } = createForgeApp(app, { sshUsername: taker.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: taker }, { terminal, exitHooks: false });
  tui.start();
  try {
    openNewApp(session, tui.ctx, blank("New app"));
    await settleApp(tui);
    const text = tui.screen.toText();
    expect(text).toContain("Start from which template? giver/kits/cli, giver/");
    expect(text).toContain("▏ giver/kits/cli");
  } finally {
    tui.stop();
  }
});
