/**
 * The terminal's Connection apps screen (src/tui/screens/originapps.ts, #7291):
 * add, list without the secret, a bad host refused in the API's words, and
 * remove after a confirm. No frame and no log line holds the secret.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOriginApps } from "../src/actions/origins.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { connectMessage } from "../src/http/api.ts";
import { logLevel, setLogLevel, type LogLevel } from "../src/kernel/log.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

const SECRET = "s3cr3t_Qw9zXv";
const RIGHT = "\x1b[C";
const open = [":", "Connection apps", "\r"];

let dir: string;
let app: App;
let alice: User;
let found: LogLevel;
const frames: string[] = [];
const logged: string[] = [];
const spies: { mockRestore(): void }[] = [];

async function drive(keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: alice.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice },
    { terminal, exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
    frames.push(tui.screen.toText());
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  found = logLevel();
  setLogLevel("debug");
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.join(" "))));
  }
  dir = await mkdtemp(join(tmpdir(), "forge-tui-originapps-"));
  app = createApp({ dataDir: dir, port: 0 });
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  alice = r.value;
});
afterAll(async () => {
  for (const s of spies) s.mockRestore();
  setLogLevel(found);
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the terminal's origin apps screen", () => {
  test("a refused host says MCP's words and registers nothing", async () => {
    const text = await drive([...open, "a", "not a host!", "\r", "cid", "\r", SECRET, "\r"]);
    expect(text).toContain(connectMessage("unknown_host"));
    expect(listOriginApps(app, alice)).toEqual([]);
  });

  test("add: listed with its client id and hasSecret, the secret nowhere", async () => {
    const text = await drive([...open, "a", "github", "\r", "Iv1.abc123", "\r", SECRET, "\r"]);
    const rows = listOriginApps(app, alice);
    expect(rows.map((r) => [r.kind, r.clientId, r.hasSecret])).toEqual([["github", "Iv1.abc123", true]]);
    expect(text).toContain("github.com is registered.");
    expect(text).toContain("client Iv1.abc123 · secret set");
    expect(frames.some((f) => f.includes("•".repeat(SECRET.length)))).toBe(true);
    for (const f of frames) expect(f).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  test("d asks first; keeping leaves it, confirming removes it", async () => {
    const asked = await drive([...open, "d"]);
    expect(asked).toContain("Remove this origin app");
    expect(listOriginApps(app, alice).length).toBe(1);
    await drive([...open, "d", "\r"]);
    expect(listOriginApps(app, alice).length).toBe(1);
    const text = await drive([...open, "d", RIGHT, "\r"]);
    expect(listOriginApps(app, alice)).toEqual([]);
    expect(text).toContain("github.com is removed.");
    for (const f of frames) expect(f).not.toContain(SECRET);
  });
});
