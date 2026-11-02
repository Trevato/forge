/**
 * Making a token in the terminal (#8092): `m` on the Signed-in screen asks a
 * name and a scope, mints through `createToken` (so `token.created` is
 * emitted), shows the secret once on a screen of its own, and forgets it.
 * Admin is offered only to an admin and needs a second `y`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { listTokens } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { signInsScreen } from "../src/tui/screens/signins.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("making a token in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const { app } = createForgeApp(
      forge,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      out: () => terminal.output(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      open: async () => {
        key("k", true);
        await settleApp(app);
        for (const ch of "Signed in") key(ch);
        await settleApp(app);
        key("enter");
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-token-make-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["boss", true], ["carol", false], ["bot1", false]] as const) {
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
    forge.db.query("UPDATE user SET is_agent = 1 WHERE username = 'bot1'").run();
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("m mints an rw token, shows the secret once, and the list shows it used", async () => {
    const h = boot("carol");
    await h.open();
    await h.press("m");
    expect(h.text()).toContain("Name");
    await h.press("backspace", "backspace", "backspace", "backspace", "backspace");
    await h.type("ci");
    await h.press("enter");
    expect(h.text()).toContain("Scope: ro or rw");
    await h.press("backspace", "backspace");
    await h.type("rw");
    await h.press("enter");
    const text = h.text();
    expect(text).toContain("copy it now, it is never shown again.");
    const carol = getUserByName(forge.db, "carol")!;
    expect(listTokens(forge.db, carol.id).some((t) => t.name === "ci" && t.scope === "rw")).toBe(true);
    const secret = text.match(/forge_[A-Za-z0-9_-]+/)?.[0];
    expect(secret).toBeDefined();
    expect(listEvents(forge.db, { kind: "token.created" }).length).toBeGreaterThan(0);
    await h.press("esc");
    const after = h.text();
    expect(after).not.toContain(secret!);
    expect(after).toContain("ci · rw");
    expect(after).toMatch(/ci · rw[\s\S]*last seen never/);
    h.stop();
  });

  test("a non-admin is never offered admin and nothing is made", async () => {
    const h = boot("carol");
    await h.open();
    const before = listTokens(forge.db, getUserByName(forge.db, "carol")!.id).length;
    await h.press("m", "enter");
    expect(h.text()).not.toContain("admin");
    await h.press("backspace", "backspace");
    await h.type("admin");
    await h.press("enter");
    expect(h.text()).toContain("Only an admin can make a token");
    expect(listTokens(forge.db, getUserByName(forge.db, "carol")!.id).length).toBe(before);
    h.stop();
  });

  test("an admin needs a second y for admin scope", async () => {
    const h = boot("boss");
    await h.open();
    await h.press("m", "enter");
    expect(h.text()).toContain("ro, rw or admin");
    await h.press("backspace", "backspace");
    await h.type("admin");
    await h.press("enter");
    expect(h.text()).toContain("will act as admin");
    const root = getUserByName(forge.db, "boss")!;
    await h.press("n");
    expect(listTokens(forge.db, root.id).length).toBe(0);
    await h.press("m", "enter");
    await h.press("backspace", "backspace");
    await h.type("admin");
    await h.press("enter");
    await h.press("y");
    expect(h.text()).toContain("copy it now");
    expect(listTokens(forge.db, root.id).some((t) => t.scope === "admin")).toBe(true);
    h.stop();
  });

  const count = (name: string) => listTokens(forge.db, getUserByName(forge.db, name)!.id).length;

  test("an empty name and a name over 64 characters are refused and nothing is made", async () => {
    const h = boot("carol");
    await h.open();
    const before = count("carol");
    await h.press("m", "backspace", "backspace", "backspace", "backspace", "backspace", "enter");
    expect(h.text()).toContain("A token needs a name.");
    await h.type("x".repeat(65));
    await h.press("enter");
    expect(h.text()).toContain("Keep the name to 64 characters.");
    expect(h.text()).not.toContain("Scope: ro or rw");
    expect(count("carol")).toBe(before);
    h.stop();
  });

  test("an unknown scope word is refused and nothing is made", async () => {
    const h = boot("carol");
    await h.open();
    const before = count("carol");
    await h.press("m", "enter");
    await h.press("backspace", "backspace");
    await h.type("root");
    await h.press("enter");
    expect(h.text()).toContain("Type ro or rw.");
    expect(count("carol")).toBe(before);
    h.stop();
  });

  test("a guest and an agent pressing m get nothing and no prompt opens", () => {
    const pushed: unknown[] = [];
    const ctx = { push: (s: unknown) => pushed.push(s), invalidate() {} } as never;
    const press = (session: Session) =>
      signInsScreen(session, ctx).key?.({ type: "key", key: "m", ctrl: false, alt: false, shift: false } as never);
    press(new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1" }));
    const bot = getUserByName(forge.db, "bot1")!;
    press(new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: bot }));
    expect(pushed).toEqual([]);
    expect(count("bot1")).toBe(0);
  });

  test("y on the secret screen copies the whole secret to the clipboard", async () => {
    const h = boot("carol");
    await h.open();
    await h.press("m", "enter");
    await h.press("enter");
    const secret = h.text().match(/forge_[A-Za-z0-9_-]+/)?.[0];
    expect(secret).toBeDefined();
    await h.press("y");
    expect(h.text()).toContain("Copied.");
    expect(h.out()).toContain(`\x1b]52;c;${Buffer.from(secret!, "utf8").toString("base64")}\x07`);
    h.stop();
  });

  test("esc from the admin confirm leaves no token", async () => {
    const h = boot("boss");
    await h.open();
    const before = count("boss");
    await h.press("m", "enter");
    await h.press("backspace", "backspace");
    await h.type("admin");
    await h.press("enter");
    expect(h.text()).toContain("will act as admin");
    await h.press("esc");
    expect(h.text()).not.toContain("copy it now");
    expect(count("boss")).toBe(before);
    h.stop();
  });

  test("a narrow terminal wraps the secret whole and says y copies it", async () => {
    const terminal = headlessTerminal(40, 24);
    const user = getUserByName(forge.db, "carol")!;
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    key("k", true);
    await settleApp(app);
    for (const ch of "Signed in") key(ch);
    await settleApp(app);
    key("enter");
    await settleApp(app);
    key("m");
    await settleApp(app);
    key("enter");
    await settleApp(app);
    key("enter");
    await settleApp(app);
    const rows = app.screen.toText().split("\n").map((l) => l.trim());
    const joined = rows.join("");
    const secret = joined.match(/forge_[A-Za-z0-9_-]+/)?.[0] ?? "";
    expect(secret.length).toBeGreaterThan(40);
    expect(joined).toContain("y copies it whole");
    app.stop();
  });
});
