/**
 * The terminal's "Back up data" screen (src/tui/screens/appbackup.ts, #11701):
 * an admin seals and proves an app's production data; the passphrase is in no
 * frame and no log line; a non-admin is not offered it.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { envDataDir } from "../src/apps/data.ts";
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

const SECRET = "tr0ub4dor-and-three";
const open = [":", "Back up data", "\r"];
const DONE = /PROVEN|RED|wrong passphrase/;
let dir: string;
let app: App;
let admin: User;
let writer: User;
let shop: Repo;
let found: LogLevel;
const frames: string[] = [];
const logged: string[] = [];
const spies: { mockRestore(): void }[] = [];
const backups = () => {
  const d = join(dir, "app-backups", getAppByRepo(app.db, shop.id)!.id);
  try { return readdirSync(d); } catch { return []; }
};

/** `until`: the seal and the proof run in a child process, so wait for its answer to be painted. */
async function drive(user: User, keys: string[], until?: RegExp): Promise<string> {
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
  const deadline = Date.now() + 20_000;
  while (until !== undefined && !until.test(tui.screen.toText()) && Date.now() < deadline) {
    await Bun.sleep(25);
    await settleApp(tui);
    frames.push(tui.screen.toText());
  }
  if (until !== undefined && !until.test(tui.screen.toText())) throw new Error(`timed out waiting for ${until}`);
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
  dir = await mkdtemp(join(tmpdir(), "forge-tui-appbackup-"));
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
  const data = envDataDir(dir, getAppByRepo(app.db, shop.id)!.id, "production");
  mkdirSync(join(data, "uploads"), { recursive: true });
  writeFileSync(join(data, "uploads/a.txt"), "hello");
});
afterAll(async () => {
  for (const s of spies) s.mockRestore();
  setLogLevel(found);
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the terminal's back up screen", () => {
  test("a non-admin is not offered it", async () => {
    expect(await drive(writer, [":", "Back up data"])).not.toContain("— Back up data");
    expect(await drive(admin, [":", "Back up data"])).toContain("— Back up data");
  });

  test("a short passphrase is refused and nothing is written", async () => {
    const text = await drive(admin, [...open, "s", "short", "\r"]);
    expect(text).toContain("under 12");
    expect(backups()).toEqual([]);
  });

  test("s seals and proves; p proves it again; the passphrase is nowhere", async () => {
    const sealed = await drive(admin, [...open, "s", SECRET, "\r"], DONE);
    expect(sealed).toContain("PROVEN: 1 files");
    expect(backups().length).toBe(1);
    expect(frames.some((f) => f.includes("•".repeat(SECRET.length)))).toBe(true);
    const proved = await drive(admin, [...open, "p", SECRET, "\r"], DONE);
    expect(proved).toContain("PROVEN: 1 files");
    const wrong = await drive(admin, [...open, "p", "another passphrase", "\r"], DONE);
    expect(wrong).toContain("wrong passphrase");
    for (const f of frames) expect(f).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  }, 90_000); // three child processes seal and prove: past the 5 s default on a busy shard
});
