/**
 * The terminal's pull screen says how the origin's own check stands on a
 * mirrored pull, in the words the web page uses (#8965, both doors).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { getRepoById } from "../src/core/repos.ts";
import { getPull } from "../src/core/pulls.ts";
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-origin-check-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a mirrored pull shows the origin's check and when it said so; a pull it never reported on shows none", async () => {
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
  for (const branch of ["main", "feat"]) {
    const c = await commitToBranch(app, alice, r.value, {
      branch,
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
  const o = await openPull(app, alice, r.value, { title: "Pull feat", body: "", baseBranch: "main", headBranch: "feat" });
  if (!o.ok) throw new Error(String(o.error));
  const origin = createOrigin(app.db, dataDir, {
    userId: alice.id,
    kind: "forgejo",
    apiUrl: "https://bob.test/api/v1",
    webUrl: "https://bob.test",
    login: "bob",
    token: "t",
    software: "forge",
  });
  if (!origin.ok) throw new Error(origin.error);
  linkRepoToOrigin(app.db, r.value.id, {
    originId: origin.value.id,
    fullName: "bob/lib",
    remoteId: "1",
    htmlUrl: "https://bob.test/bob/lib",
  });
  const pull = getPull(app.db, r.value.id, o.value.number)!;

  const screenText = async () => {
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
      { terminal: headlessTerminal(160, 44), exitHooks: false },
    );
    tui.start();
    const repo = getRepoById(app.db, r.value.id)!;
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop();
    return text;
  };

  expect(await screenText()).not.toContain("Check on");

  app.db
    .query("INSERT INTO origin_pull_check (issue_id, head_oid, word, checked_at) VALUES (?1, ?2, 'green', '2026-11-03T10:15:00.000Z')")
    .run(pull.id, pull.headOid);
  expect(await screenText()).toContain("Check on bob/lib: passing, as of 2026-11-03 10:15 UTC");
});
