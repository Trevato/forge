/** The crew scorecard in the terminal (#2682): an admin sees the per-model and per-prompt cuts; others have no command. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { claimRun, createRun, finishRun, noteRunProgress } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;

function boot(username: string) {
  const user = getUserByName(forge.db, username)!;
  const { app } = createForgeApp(
    forge,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  app.start();
  const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  return {
    text: () => app.screen.toText(),
    palette: async (word: string) => {
      key("k", true);
      for (const ch of word) key(ch);
      await settleApp(app);
    },
    enter: async () => {
      key("enter");
      await settleApp(app);
    },
    stop: () => app.stop(),
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-splits-"));
  forge = createApp({ dataDir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["smith", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  const repoId = (forge.db
    .query<{ id: string }, []>("SELECT id FROM repo LIMIT 1")
    .get()?.id) ?? "";
  forge.db.run("PRAGMA foreign_keys = OFF");
  const agentId = getUserByName(forge.db, "smith")!.id;
  for (const [model, version] of [["claude-opus-5-5", "abc123"], ["", ""]] as const) {
    const run = createRun(forge.db, { repoId, kind: "agent", actorId: agentId });
    claimRun(forge.db, run.id);
    noteRunProgress(forge.db, run.id, { model, promptVersion: version });
    finishRun(forge.db, run.id, { state: "ok", summary: "", costUsd: 0.1 });
  }
});
afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an admin's terminal shows the cuts, with the empty key as default / not recorded", async () => {
  const h = boot("alice");
  await h.palette("Crew scorecard");
  await h.enter();
  const text = h.text();
  expect(text).toContain("model: claude-opus-5-5");
  expect(text).toContain("model: default");
  expect(text).toContain("prompt: abc123");
  expect(text).toContain("prompt: not recorded");
  expect(text).toContain(`day ${new Date().toISOString().slice(0, 10)}: claude-opus-5-5`);
  expect(text).toContain("1 runs");
  h.stop();
});

test("a non-admin has no command", async () => {
  const h = boot("bob");
  await h.palette("Crew scorecard");
  expect(h.text()).not.toContain("agent runs per model and per prompt version");
  h.stop();
});
