/** The terminal's dashboard says why the builders are idle in the one line, for an admin alone (#7663). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { idleLine, idleReason } from "../src/crew/idle_reason.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-idle-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "b@forge.test",
    password: "a-long-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  bob = b.value;
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

test("the admin's home prints the reason's line; nobody else's does", async () => {
  const made = await createRepo(forge, alice, { name: "svc", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const created = await createAgent(forge, alice, { username: "idlebot" });
  if (!created.ok) throw new Error(String(created.error));
  expect(addToCrew(forge, alice, made.value, "idlebot").ok).toBe(true);
  forge.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_ceiling_usd = 1, autonomy_slots = 2 WHERE id = ?1")
    .run(made.value.id, alice.id);
  const run = createRun(forge.db, { repoId: made.value.id, kind: "agent", actorId: getUserByName(forge.db, "idlebot")!.id });
  forge.db.query("UPDATE run SET cost_usd = 5, state = 'ok' WHERE id = ?1").run(run.id);

  const reason = idleReason(forge, new Date());
  expect(reason).toEqual({ word: "ceiling reached", href: "/meter" });
  expect(await firstScreen(alice)).toContain(idleLine(reason!));
  expect(await firstScreen(bob)).not.toContain("Builders idle");
});

test("the builders line ends with the reason's word while a slot is free; with every slot busy it has none", async () => {
  const repo = forge.db.query("SELECT id FROM repo WHERE name = 'svc'").get() as { id: string };
  forge.db.query("UPDATE repo SET autonomy_ceiling_usd = 1000 WHERE id = ?1").run(repo.id);
  const reason = idleReason(forge, new Date());
  expect(reason?.word).toBe("nothing ready");
  const free = await firstScreen(alice);
  expect(free).toMatch(new RegExp(`Builders running .* · ${reason!.word}`));

  const bot = getUserByName(forge.db, "idlebot")!;
  for (let i = 0; i < 2; i++) createRun(forge.db, { repoId: repo.id, kind: "agent", actorId: bot.id });
  expect(idleReason(forge, new Date())).toBeNull();
  const busy = await firstScreen(alice);
  expect(busy).toContain("Builders running");
  expect(busy).not.toContain("nothing ready");
});
