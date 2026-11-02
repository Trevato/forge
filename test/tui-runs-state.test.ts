/** The terminal's runs list cycles a state filter, as the web row does (#6490). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { runsScreen } from "../src/tui/screens/runs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let repo: Repo;
let alice: import("../src/core/users.ts").User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-runs-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
  const done = createRun(forge.db, { repoId: repo.id, kind: "check", summary: "GREEN-MARK" });
  claimRun(forge.db, done.id);
  finishRun(forge.db, done.id, { state: "ok", summary: "GREEN-MARK" });
  const bad = createRun(forge.db, { repoId: repo.id, kind: "check" });
  claimRun(forge.db, bad.id);
  finishRun(forge.db, bad.id, { state: "failed", summary: "RED-MARK" });
  const agent = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, agent.id);
  finishRun(forge.db, agent.id, { state: "failed", summary: "AGENT-RED-MARK" });
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

test("s cycles All, Failed, Running, Succeeded and the list follows", async () => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(runsScreen(session, app.ctx, repo));
  await settleApp(app);
  const press = async (key: string): Promise<string> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    return app.screen.toText();
  };
  let text = app.screen.toText();
  expect(text).toContain("GREEN-MARK");
  expect(text).toContain("RED-MARK");
  text = await press("s");
  expect(text).toContain("Failed");
  expect(text).toContain("RED-MARK");
  expect(text).toContain("AGENT-RED-MARK");
  expect(text).not.toContain("GREEN-MARK");
  text = await press("s");
  expect(text).toContain("No running runs");
  text = await press("s");
  expect(text).toContain("GREEN-MARK");
  expect(text).not.toContain("RED-MARK");
  text = await press("s");
  expect(text).toContain("GREEN-MARK");
  expect(text).toContain("RED-MARK");
  app.stop();
});
