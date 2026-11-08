/** The changelog in the terminal: the palette offers it to a guest, and the screen lists the page's releases. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { changelogScreen } from "../src/tui/screens/changelog.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
const guest = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-changelog-"));
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
  app.config.forgeRepo = "alice/forge";
  for (const [n, message] of ["Release 0.1.0: Older (#1)", "Release 0.2.0: Newer thing (#2)"].entries()) {
    const done = await commitToBranch(app, made.value, repo.value, {
      message,
      files: [{ path: `f${n}.txt`, content: `${n}\n` }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  // The pulls the releases name, so Enter has a pull to open: #1 then #2.
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

test("a guest is offered the changelog and sees the releases newest first", async () => {
  expect(forgeCommands(new Session(app, guest))({} as Ctx).some((c) => c.id === "changelog")).toBe(true);
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(changelogScreen(session, tui.ctx));
  await settleApp(tui);
  const text = tui.screen.toText();
  terminal.feed("\r");
  await settleApp(tui);
  terminal.feed("\r");
  await settleApp(tui);
  const opened = tui.screen.toText();
  tui.stop?.();
  // Enter lists the newest release's pulls, Enter again opens pull #2's own screen.
  expect(opened).not.toBe(text);
  expect(opened).toContain("Changelog › 0.2.0 › #2");
  expect(opened).not.toContain("0.1.0");
  expect(text.indexOf("0.2.0")).toBeGreaterThan(-1);
  expect(text.indexOf("0.2.0")).toBeLessThan(text.indexOf("0.1.0"));
  expect(text).toContain("#2 Newer thing");
});

test("a private forge repository leaves the terminal's screen empty", async () => {
  app.db.run("UPDATE repo SET visibility = 'private' WHERE name = 'forge'");
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  try {
    tui.start();
    tui.ctx.push(changelogScreen(session, tui.ctx));
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("No releases yet");
    expect(text).not.toContain("0.2.0");
    expect(text).not.toContain("#2");
  } finally {
    app.db.run("UPDATE repo SET visibility = 'public' WHERE name = 'forge'");
  }
});
