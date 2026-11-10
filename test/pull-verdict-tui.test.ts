/**
 * The terminal's pull screen opens on the same verdict as the page, in the
 * same words (`verdictOf`).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-verdict-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the pull screen names whether it can land and what holds it", async () => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const repo = r.value;
  const put = async (branch: string, file: string, content: string) => {
    const c = await commitToBranch(app, alice, repo, {
      branch,
      ...(branch === "main" ? {} : { base: "main" }),
      message: branch,
      files: [{ path: file, content }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  };
  await put("main", "a.txt", "main");
  await put("clean", "c.txt", "x");
  await put("clash", "a.txt", "theirs");
  await put("main", "a.txt", "ours");
  const open = async (branch: string) => {
    const o = await openPull(app, alice, repo, { title: branch, body: "", baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    return o.value.number;
  };
  const clean = await open("clean");
  const clash = await open("clash");

  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:alice", user: alice },
    { terminal: headlessTerminal(160, 44), exitHooks: false },
  );
  tui.start();
  const show = async (number: number): Promise<string> => {
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), number));
    await settleApp(tui);
    return tui.screen.toText();
  };
  try {
    expect(await show(clean)).toContain("Ready to land");
    expect(await show(clash)).toContain("Conflicts with main");
    app.db.run("UPDATE repo SET require_checks = 1 WHERE id = ?", [repo.id]);
    expect(await show(clean)).toContain("Waiting for the check");
  } finally {
    tui.stop();
  }
});
