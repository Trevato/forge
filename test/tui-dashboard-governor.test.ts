/** The terminal's repository row says why the governor holds the crew below its slots, as the studio's crew card does (#7644). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createRepo, getRepo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { announceGovernor, governorSeen } from "../src/crew/governed.ts";
import { id } from "../src/kernel/id.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-governor-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  for (const name of ["flooded", "calm"]) {
    const r = await createRepo(forge.db, forge.reposRoot, { ownerId: alice.id, name, visibility: "public", description: `the ${name} one` });
    if (!r.ok) throw new Error(r.error);
  }
  forge.db.run("UPDATE repo SET autonomy = 'assisted', autonomy_slots = 4");
});

afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

async function firstScreen(user: User): Promise<string> {
  const terminal = headlessTerminal(200, 32);
  const { app } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
}

test("a flooded repository's row says the governor's reason; one at its ceiling keeps its description", async () => {
  const repo = getRepo(forge.db, "alice", "flooded")!;
  // 12 pulls opened in the last few minutes, none landed: a flood.
  for (let n = 1; n <= 12; n++) {
    const issueId = id();
    forge.db.run(
      "INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', 't', ?4, 'open')",
      [issueId, repo.id, n, alice.id],
    );
    forge.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, '', 'h')", [issueId, `b/${n}`]);
  }
  const g = governorSeen(forge, alice, repo, new Date())!;
  expect(g.held).toBe(true);
  expect(g.says).toBe("");
  expect(g.why).toStartWith("Builders 4 → 1:");
  const screen = await firstScreen(alice);
  expect(screen).toContain(g.why);
  expect(screen).toContain("the calm one");
  expect(screen).not.toContain("the flooded one");
});

test("once the governor has changed the slots the row says the line (#11459)", async () => {
  const repo = getRepo(forge.db, "alice", "flooded")!;
  forge.db.run("INSERT INTO governor_last (repo_id, from_slots, to_slots, why, at) VALUES (?1, 4, 4, 'w', 0)", [repo.id]);
  announceGovernor(forge, repo, new Date());
  const g = governorSeen(forge, alice, repo, new Date())!;
  expect(g.says).toStartWith("Builders 4 → 1 at ");
  expect(await firstScreen(alice)).toContain(g.says.slice(0, 60));
});
