/** `/` narrows the changelog by a word; Enter on a release lists its pulls and Enter on a pull opens it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { changelogScreen } from "../src/tui/screens/changelog.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let owner: Awaited<ReturnType<typeof createUser>> & { ok: true };
let repoRow: Awaited<ReturnType<typeof createRepo>> & { ok: true };
const guest = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-changelog-find-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@f.dev",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const repo = await createRepo(app, made.value, { name: "forge", visibility: "public" });
  if (!repo.ok) throw new Error(JSON.stringify(repo.error));
  owner = made;
  repoRow = repo;
  app.config.forgeRepo = "alice/forge";
  for (const [n, message] of ["Release 0.1.0: Older (#1)", "Release 0.2.0: Newer thing (#2)"].entries()) {
    const done = await commitToBranch(app, made.value, repo.value, {
      message,
      files: [{ path: `f${n}.txt`, content: `${n}\n` }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  for (const [n, title] of ["Older", "Newer thing"].entries()) {
    const branch = `p${n + 1}`;
    const done = await commitToBranch(app, made.value, repo.value, {
      message: title,
      branch,
      files: [{ path: `p${n}.txt`, content: `${n}\n` }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const pull = await openPull(app, made.value, repo.value, { title, baseBranch: repo.value.defaultBranch, headBranch: branch });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  }
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a word of a pull's title narrows to its release, esc clears it, Enter lists and opens the pull", async () => {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(changelogScreen(session, tui.ctx));
  await settleApp(tui);
  const all = tui.screen.toText();
  expect(all).toContain("2 releases");
  expect(all).toContain("0.1.0");

  terminal.feed("/NEWER");
  await settleApp(tui);
  const narrowed = tui.screen.toText();
  expect(narrowed).toContain("1 of 2 releases match");
  expect(narrowed).toContain("0.2.0");
  expect(narrowed).not.toContain("0.1.0");

  terminal.feed("\x1b");
  await new Promise((r) => setTimeout(r, 60));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("0.1.0");

  terminal.feed("/older\r");
  await settleApp(tui);
  terminal.feed("\r");
  await settleApp(tui);
  const pulls = tui.screen.toText();
  expect(pulls).toContain("#1 Older");
  expect(pulls).not.toContain("#2");

  terminal.feed("\r");
  await settleApp(tui);
  const opened = tui.screen.toText();
  tui.stop?.();
  expect(opened).toContain("#1");
  expect(opened).toContain("0.1.0 › #1");
});

test("a release naming no pull lists none and survives j", async () => {
  const done = await commitToBranch(app, owner.value, repoRow.value, {
    message: "Release 0.3.0: Quiet",
    files: [{ path: "quiet.txt", content: "q\n" }],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(changelogScreen(session, tui.ctx));
  await settleApp(tui);
  terminal.feed("\r");
  await settleApp(tui);
  const none = tui.screen.toText();
  expect(none).toContain("No pulls");
  terminal.feed("j");
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("No pulls");
  tui.stop?.();
});
