/**
 * The terminal's door to a 3D model (#7335): where the page draws the part,
 * the file view names it, counts its triangles, measures it in millimetres
 * and says where to download it, instead of "Binary file".
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

let dataDir = "";
let forge: Forge;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-model3d-"));
  forge = createApp({ dataDir, port: 0, url: "https://forge.test" });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  const made = await createRepo(forge, a.value, { name: "tower", visibility: "public" });
  if (!made.ok) throw new Error("repo failed");
  await commitToBranch(forge, a.value, made.value, {
    message: "parts",
    files: [
      { path: "README.md", content: "# tower\n" },
      { path: "parts/cube.stl", content: await Bun.file(join(import.meta.dir, "fixtures", "model3d", "cube-binary.stl")).bytes() },
    ],
  });
});

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a binary STL reads as a 3D model with its triangles, its box and where to download it", async () => {
  const user = getUserByName(forge.db, "alice");
  if (user === undefined) throw new Error("no alice");
  const { app } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal: headlessTerminal(140, 40), exitHooks: false },
  );
  app.start();
  const send = (key: string): void => app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  try {
    await settleApp(app);
    send("/");
    for (const ch of "tower") send(ch);
    send("enter");
    send("enter");
    await settleUntil(app, "alice/tower");
    send("t");
    await settleApp(app);
    for (const ch of "cubestl") send(ch);
    send("enter");
    await settleUntil(app, "12 triangles");
    const text = app.screen.toText();
    expect(text).toContain("3D model · STL");
    expect(text).toContain("12 triangles · 20 × 20 × 20 mm");
    expect(text).toContain("Download: https://forge.test/alice/tower/media/main/parts/cube.stl?download=1");
    expect(text).not.toContain("Binary file");
  } finally {
    app.stop();
  }
});

test("a guest in the terminal gets nothing of a model in a private repo", async () => {
  const alice = getUserByName(forge.db, "alice");
  if (alice === undefined) throw new Error("no alice");
  const made = await createRepo(forge, alice, { name: "secret-part", visibility: "private" });
  if (!made.ok) throw new Error("repo failed");
  await commitToBranch(forge, alice, made.value, {
    message: "part",
    files: [{ path: "hidden.stl", content: await Bun.file(join(import.meta.dir, "fixtures", "model3d", "cube-binary.stl")).bytes() }],
  });
  const { app } = createForgeApp(
    forge,
    { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:unknown" },
    { terminal: headlessTerminal(140, 40), exitHooks: false },
  );
  app.start();
  const send = (key: string): void => app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  try {
    await settleApp(app);
    send("/");
    for (const ch of "secret-part") send(ch);
    send("enter");
    send("enter");
    await settleApp(app);
    send("t");
    await settleApp(app);
    for (const ch of "hiddenstl") send(ch);
    send("enter");
    await settleApp(app);
    const text = app.screen.toText();
    expect(text).not.toContain("secret-part");
    expect(text).not.toContain("12 triangles");
    expect(text).not.toContain("hidden.stl");
    expect(text).not.toContain("3D model");
  } finally {
    app.stop();
  }
});
