/**
 * What the terminal's variables screen (src/tui/screens/appenv.ts, #7232)
 * promises about a secret: the value typed into the masked field is in no
 * frame, no toast and no log line, and `d` unsets only after a confirm. The
 * flow itself is in tui-app-env.test.ts; this file watches the console and
 * every frame while an admin adds, declines, and confirms.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { APP_ENV_ERRORS } from "../src/actions/app_env_words.ts";
import { createApp, type App } from "../src/app.ts";
import { listAppEnvNames } from "../src/core/app_env.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { logLevel, setLogLevel, type LogLevel } from "../src/kernel/log.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

const SECRET = "hunter2_Zq9xW";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const open = [":", "Variables", "\r"];

let dir: string;
let app: App;
let admin: User;
let writer: User;
let shop: Repo;
let found: LogLevel;
const frames: string[] = [];
const logged: string[] = [];
const spies: { mockRestore(): void }[] = [];

const vars = () => listAppEnvNames(app.db, getAppByRepo(app.db, shop.id)!.id);

async function drive(user: User, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, shop)));
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
  dir = await mkdtemp(join(tmpdir(), "forge-tui-appenv-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  admin = await mk("alice", true);
  writer = await mk("walt");
  proveAll(app);
  const made = await newApp(app, admin, { name: "shop", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  shop = getRepo(app.db, admin.username, "shop")!;
});
afterAll(async () => {
  for (const s of spies) s.mockRestore();
  setLogLevel(found);
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the terminal's variables screen", () => {
  test("an admin adds a masked value: name and scope listed, the value nowhere", async () => {
    const text = await drive(admin, [...open, "a", "API_TOKEN", "\r", SECRET, "\r", DOWN, "\r"]);
    expect(vars().map((v) => [v.name, v.scope])).toEqual([["API_TOKEN", "production"]]);
    expect(text).toContain("API_TOKEN is set for production.");
    expect(text).toContain("production · set");
    expect(frames.some((f) => f.includes("•".repeat(SECRET.length)))).toBe(true);
    for (const f of frames) expect(f).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  test("d asks first; keeping it leaves it, confirming unsets it", async () => {
    const asked = await drive(admin, [...open, "d"]);
    expect(asked).toContain("Unset this variable");
    expect(vars().length).toBe(1);
    await drive(admin, [...open, "d", "\r"]);
    expect(vars().length).toBe(1);
    const text = await drive(admin, [...open, "d", RIGHT, "\r"]);
    expect(vars()).toEqual([]);
    expect(text).toContain("API_TOKEN is unset for production.");
  });

  test("a non-admin is not offered the entry; a bad name is refused in MCP's words", async () => {
    expect(await drive(writer, [":", "Variables"])).not.toContain("— Variables");
    expect(await drive(admin, [":", "Variables"])).toContain("— Variables");
    const text = await drive(admin, [...open, "a", "bad name", "\r", SECRET, "\r", "\r"]);
    expect(text).toContain(APP_ENV_ERRORS["invalid_name"]!.slice(0, 50));
    expect(vars()).toEqual([]);
    for (const f of frames) expect(f).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});
