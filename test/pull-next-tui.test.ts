import { afterAll, beforeAll, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-next-tui-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the terminal's pull screen says who acts next, as the page does", async () => {
  const repo = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  for (const branch of ["main", "topic"]) {
    const done = await commitToBranch(app, alice, repo.value, {
      branch,
      message: "edit",
      files: [{ path: `${branch}.txt`, content: "x\n" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const opened = await openPull(app, alice, repo.value, {
    title: "Topic",
    baseBranch: "main",
    headBranch: "topic",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:alice", user: alice },
    { terminal: headlessTerminal(140, 44), exitHooks: false },
  );
  tui.start();
  try {
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo.value), opened.value.number));
    const end = Date.now() + 20_000;
    while (!tui.screen.toText().includes("next: reviewer, no review yet")) {
      if (Date.now() > end) throw new Error(tui.screen.toText());
      await settleApp(tui);
      await Bun.sleep(20);
    }
    // The page's step line, too: this pull is at review.
    if (!tui.screen.toText().includes("step: Review — ")) throw new Error(tui.screen.toText());
  } finally {
    tui.stop();
  }
});
