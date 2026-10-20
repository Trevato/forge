/** #3135: About, in the terminal, says the check cell's memory in the settings page's words. */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dataDir = "";
let forge: Forge;
let alice: User;
const saved = process.env["FORGE_CELL_MEMORY_MAX_MIB"];

beforeAll(async () => {
  process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-cellmem-"));
  forge = createApp({ dataDir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const made = await createRepo(forge, alice, { name: "beacon", visibility: "public" });
  if (!made.ok) throw new Error("repo failed");
  const c = await commitToBranch(forge, alice, made.value, {
    message: "forge.json",
    files: [{ path: "forge.json", content: '{"check":{"run":"true","limits":{"memory":8192}}}' }],
  });
  if (!c.ok) throw new Error("commit failed");
});

afterAll(async () => {
  if (saved === undefined) delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
  else process.env["FORGE_CELL_MEMORY_MAX_MIB"] = saved;
  await rm(dataDir, { recursive: true, force: true });
});

test("About shows the cut and its source to an admin", async () => {
  const terminal = headlessTerminal(160, 40);
  const { app } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice },
    { terminal, exitHooks: false },
  );
  app.start();
  const press = async (...keys: string[]) => {
    for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  await settleApp(app);
  await press("/");
  for (const ch of "beacon") await press(ch);
  await press("enter");
  await press("enter");
  await settleUntil(app, "alice/beacon");
  await press("I");
  await settleUntil(app, "forge.json asks 8192 MiB");
  expect(app.screen.toText()).toContain("FORGE_CELL_MEMORY_MAX_MIB");
});

test("About says the check could not be read when reading it rejects", async () => {
  const memory = await import("../src/apps/check-memory.ts");
  const spy = spyOn(memory, "checkMemoryAt").mockRejectedValue(new Error("git is gone"));
  try {
    const terminal = headlessTerminal(160, 40);
    const { app } = createForgeApp(
      forge,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice },
      { terminal, exitHooks: false },
    );
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    await settleApp(app);
    await press("/");
    for (const ch of "beacon") await press(ch);
    await press("enter");
    await press("enter");
    await settleUntil(app, "alice/beacon");
    await press("I");
    await settleUntil(app, "could not be read");
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
