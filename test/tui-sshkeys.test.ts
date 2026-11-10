/**
 * Computer keys in the terminal (#7242): your own keys listed, one added, a bad
 * line refused in MCP's words, one removed after a confirm.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addKey, listKeys, parseAuthorizedKey } from "../src/core/keys.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

/** A well-formed ed25519 authorized_keys line whose 32 key bytes are all `fill`. */
const line = (fill: number, comment = "") => {
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, fill),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`.trim();
};

describe("Computer keys in the terminal", () => {
  let dataDir: string;
  let app: App;

  const seed = (owner: string, name: string, fill: number) => {
    const parsed = parseAuthorizedKey(line(fill));
    if (!parsed.ok) throw new Error("bad fixture key");
    const added = addKey(app.db, getUserByName(app.db, owner)!.id, name, parsed.value);
    if (!added.ok) throw new Error(added.error);
  };

  function boot(username: string, keyId?: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user, keyId },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = (k: string, ctrl = false) =>
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => tui.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(tui);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(tui);
      },
      open: async function () {
        key("k", true);
        await settleApp(tui);
        await this.type("Computer keys");
        await this.press("enter");
      },
      stop: () => tui.stop(),
    };
  }

  const names = (owner: string) => listKeys(app.db, getUserByName(app.db, owner)!.id).map((k) => k.name);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-sshkeys-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    for (const [username, first] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
    }
    seed("alice", "laptop", 1);
    seed("alice", "desktop", 2);
    seed("bob", "bobs-secret-box", 3);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists your two keys, never another account's", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("laptop");
    expect(h.text()).toContain("desktop");
    expect(h.text()).toContain("SHA256:");
    expect(h.text()).toContain("used never");
    expect(h.text()).not.toContain("bobs-secret-box");
    h.stop();
  });

  test("a adds a key; a malformed line and a duplicate add nothing", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("a");
    await h.type("phone");
    await h.press("enter");
    await h.type("not a key");
    await h.press("enter");
    expect(h.text()).toContain("not a public key in authorized_keys form");
    expect(names("alice")).toEqual(["laptop", "desktop"]);
    await h.press("esc");

    await h.press("a");
    await h.press("enter");
    await h.type(line(1));
    await h.press("enter");
    expect(h.text()).toContain("that key is already registered");
    expect(names("alice")).toEqual(["laptop", "desktop"]);
    await h.press("esc");

    await h.press("a");
    await h.type("phone");
    await h.press("enter");
    await h.type(line(4));
    await h.press("enter");
    expect(h.text()).toContain("phone: added.");
    expect(names("alice")).toContain("phone");
    h.stop();
  });

  test("the key this session signed in with is marked and its confirm warns; another key's does not", async () => {
    const uid = getUserByName(app.db, "alice")!.id;
    const laptop = listKeys(app.db, uid).find((k) => k.name === "laptop")!;
    const h = boot("alice", laptop.id);
    await h.open();
    expect(h.text()).toContain("laptop (this session)");
    expect(h.text()).not.toContain("desktop (this session)");
    const row = (name: string) => h.text().split("\n").findIndex((l) => l.includes(name));
    // Walk the cursor to the laptop row, confirm opens with the warning.
    if (row("laptop") > row("desktop")) await h.press("j");
    await h.press("d");
    expect(h.text()).toContain("This terminal session signed in with it.");
    await h.press("esc");
    await h.press(row("laptop") > row("desktop") ? "k" : "j");
    await h.press("d");
    expect(h.text()).toContain("Remove desktop?");
    expect(h.text()).not.toContain("This terminal session signed in with it.");
    h.stop();
  });

  test("e renames the selected key: prefilled, esc keeps it, a bad name is refused", async () => {
    const h = boot("alice");
    await h.open();
    const first = names("alice")[0]!;
    await h.press("e");
    expect(h.text()).toContain("Rename SSH key");
    expect(h.text()).toContain(first);
    await h.press("esc");
    expect(names("alice")[0]).toBe(first);

    await h.press("e");
    for (let i = 0; i < first.length; i++) await h.press("backspace");
    await h.press("enter");
    expect(h.text()).toContain("a name is 1 to 64 printable characters");
    expect(names("alice")[0]).toBe(first);
    await h.press("esc");

    await h.press("e");
    await h.type(" at home");
    await h.press("enter");
    expect(names("alice")[0]).toBe(`${first} at home`);
    expect(h.text()).toContain(`${first}: renamed to ${first} at home.`);
    expect(names("bob")).toEqual(["bobs-secret-box"]);
    h.stop();
  });

  test("d removes the selected key only after a confirm", async () => {
    const h = boot("alice");
    await h.open();
    const before = names("alice").length;
    await h.press("d");
    expect(h.text()).toContain("Remove SSH key");
    await h.press("esc");
    expect(names("alice").length).toBe(before);

    await h.press("d", "right", "enter");
    expect(h.text()).toContain(": removed.");
    expect(names("alice").length).toBe(before - 1);
    expect(names("bob")).toEqual(["bobs-secret-box"]);
    h.stop();
  });
});
