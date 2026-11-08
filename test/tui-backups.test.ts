/**
 * The snapshot destination in the terminal (#7269): the Resilience screen
 * says where snapshots go; `d` seals a destination field by field, `f`
 * forgets it after a confirm. No frame drawn may hold the access key or
 * the secret key. Each test makes the destination it reads, so any order
 * passes (#9017).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { forgetDestination, mayChangeDestination, saveDestination } from "../src/actions/destination.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { sealedSet } from "../src/snapshot/destination.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settlePalette } from "./helpers/tui.ts";

quietLogs();

const ACCESS = "AKIAEXAMPLEACCESS7269";
const SECRET = "s3cr3t/Key+ThatMustNeverShow7269";

describe("the snapshot destination in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  const saved = { ...process.env };

  /** Under a loaded machine a screen can land a turn after the first settle: settle again until it shows, and fail saying so when it never does. */
  async function until(h: { text(): string; press(...k: string[]): Promise<string> }, what: string) {
    for (let i = 0; i < 100 && !h.text().includes(what); i++) {
      await Bun.sleep(20);
      await h.press();
    }
    if (!h.text().includes(what)) throw new Error(`the screen never showed ${JSON.stringify(what)}`);
  }

  /** A destination sealed as a person admin would, without the screen. */
  function seal() {
    const made = saveDestination(forge, getUserByName(forge.db, "alice"), {
      endpoint: "https://s3.example.com",
      bucket: "forge-snaps",
      region: "eu-west-1",
      accessKey: ACCESS,
      secretKey: SECRET,
    });
    if (!made.ok) throw new Error(made.error);
  }

  /** Every frame is read as it is drawn: none may hold either key. */
  function keyless(t: string): string {
    expect(t).not.toContain(ACCESS);
    expect(t).not.toContain(SECRET);
    expect(t).not.toContain(SECRET.slice(0, 10));
    return t;
  }

  function boot(username: string) {
    const terminal = headlessTerminal(140, 40);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const frame = () => keyless(app.screen.toText());
    const key = (k: string, ctrl = false) => {
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      frame();
    };
    const press = async (...keys: string[]) => {
      for (const k of keys) key(k);
      await settleApp(app);
      return frame();
    };
    const type = async (text: string) => {
      for (const ch of text) key(ch);
      await settleApp(app);
      return frame();
    };
    const open = async () => {
      key("k", true);
      await settleApp(app);
      await type("Resilience");
      await settlePalette(app);
      return press("enter");
    };
    return { text: frame, press, type, open, stop: () => app.stop() };
  }

  beforeAll(async () => {
    for (const k of Object.keys(process.env))
      if (k.startsWith("S3_") || k === "FORGE_SNAPSHOT_DIR") delete process.env[k];
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-backups-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["carol", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
  });

  beforeEach(() => {
    const cleared = forgetDestination(forge, getUserByName(forge.db, "alice"));
    if (!cleared.ok) throw new Error(cleared.error);
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
    process.env = saved;
  });

  test("with nothing set, snapshots stay on this box", async () => {
    const h = boot("alice");
    const t = await h.open();
    expect(t).toContain("Snapshots stay on this box");
    expect(t).toContain("d sets where snapshots go, x forgets it.");
    h.stop();
  });

  test("a bad endpoint is refused in the page's words, and nothing is sealed", async () => {
    const h = boot("alice");
    await h.open();
    // The prompt says up front that a refusal is told in full on the screen behind it.
    await h.press("d");
    await until(h, "a refusal is said whole behind");
    expect(h.text()).toContain("a refusal is said whole behind");
    await h.type("ftp://user:pw@example.com");
    await h.press("enter");
    await until(h, "The endpoint must be an http(s) URL");
    // The prompt has room for the start of it; the modal covers the middle of the line behind.
    const t = h.text();
    expect(t).toContain("1/5");
    // Closed, the screen behind says it whole.
    await h.press("esc");
    await until(h, "The endpoint must be an http(s) URL without credentials in it.");
    expect(sealedSet(forge.db)).toEqual([]);
    h.stop();
  });

  test("d seals each field, and the screen reads back kind and place without a key", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("d");
    await h.type("https://s3.example.com");
    expect(await h.press("enter")).toContain("2/5");
    await h.type("forge-snaps");
    await h.press("enter");
    await h.type("eu-west-1");
    await h.press("enter");
    await h.type(ACCESS);
    expect(h.text()).toContain("•".repeat(ACCESS.length));
    await h.press("enter");
    await h.type(SECRET);
    const t = await h.press("enter");
    expect(t).toContain("Destination sealed; the next snapshot goes there.");
    expect(t).toContain("Snapshots go to s3.example.com/forge-snaps (sealed in this forge).");
    expect(sealedSet(forge.db).length).toBeGreaterThanOrEqual(4);
    h.stop();
    // Opened afresh, it still says where, and still no key.
    const again = boot("alice");
    expect(await again.open()).toContain("s3.example.com/forge-snaps");
    again.stop();
  });

  test("an agent admin reads the destination but cannot change it", async () => {
    seal();
    const h = boot("carol");
    const t = await h.open();
    expect(t).toContain("s3.example.com/forge-snaps");
    expect(t).not.toContain("d sets where snapshots go, x forgets it.");
    expect(await h.press("x")).not.toContain("Forget the destination?");
    expect(await h.press("d")).not.toContain("1/5");
    h.stop();
    // The action refuses it too, so no other door (page, MCP) lets an agent change it.
    const carol = getUserByName(forge.db, "carol")!;
    const before = sealedSet(forge.db);
    expect(saveDestination(forge, carol, { endpoint: "https://x.example", bucket: "b", region: "", accessKey: "", secretKey: "" })).toEqual({ ok: false, error: "not_found" });
    expect(forgetDestination(forge, carol).ok).toBe(false);
    expect(sealedSet(forge.db)).toEqual(before);
  });

  test("x forgets only after the confirm; f is the mirror's", async () => {
    seal();
    const h = boot("alice");
    await h.open();
    // `f` forgets the mirror (#7281), never the destination.
    expect(await h.press("f")).toContain("Forget the mirror?");
    await h.press("esc");
    expect(await h.press("x")).toContain("Forget the destination?");
    await h.press("esc");
    expect(sealedSet(forge.db).length).toBeGreaterThan(0);
    await h.press("x");
    const t = await h.press("right", "enter");
    expect(t).toContain("The sealed destination is cleared.");
    expect(t).toContain("Snapshots stay on this box");
    expect(sealedSet(forge.db)).toEqual([]);
    h.stop();
  });

  test("one rule offers set and forget: a site admin who is a person", () => {
    expect(mayChangeDestination({ isAdmin: true, kind: "user" })).toBe(true);
    expect(mayChangeDestination({ isAdmin: true, kind: "agent" })).toBe(false);
    expect(mayChangeDestination({ isAdmin: false, kind: "user" })).toBe(false);
    expect(mayChangeDestination(undefined)).toBe(false);
  });

  test("no frame ever held the access key or the secret key", async () => {
    // Sealed, then typed through the screen, then opened afresh: every frame is checked as it is drawn.
    seal();
    const h = boot("alice");
    await h.open();
    await h.press("d");
    for (const field of ["https://s3.example.com", "forge-snaps", "eu-west-1", ACCESS, SECRET]) {
      await h.type(field);
      await h.press("enter");
    }
    h.stop();
    const again = boot("alice");
    expect(await again.open()).toContain("s3.example.com/forge-snaps");
    again.stop();
    expect(sealedSet(forge.db).length).toBeGreaterThanOrEqual(4);
  });
});
