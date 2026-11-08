/**
 * "What I can do" in the terminal (#2304): every signed-in session sees its
 * role and its row of the roles table.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkEdgeLogin, linkedLogin } from "../src/core/edge_links.ts";
import { linkedParent } from "../src/core/federation.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { setMember } from "../src/core/roles.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("what I can do in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  async function shown(username: string, presses: string[] = []): Promise<string> {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    key("k", true);
    for (const ch of "What I can do") key(ch);
    key("enter");
    await settleApp(app);
    for (const k of presses) key(k);
    await settleApp(app);
    const text = app.screen.toText();
    app.stop();
    return text;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-can-"));
    forge = createApp({ dataDir, port: 0, edgeToken: "edge-secret-0123456789" });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
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
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a guest, a member and an admin each see their own row", async () => {
    const guest = await shown("bob");
    expect(guest).toContain("You are guest here.");
    expect(guest).toContain("Create a repository or copy an app: no");
    setMember(forge.db, getUserByName(forge.db, "bob")!.id, true, "x", new Date());
    const member = await shown("bob");
    expect(member).toContain("You are member here.");
    expect(member).toContain("Create a repository or copy an app: yes");
    expect(member).toContain("Administer the forge: no");
    const admin = await shown("alice");
    expect(admin).toContain("You are admin here.");
    expect(admin).toContain("Administer the forge: yes");
  });

  test("with nothing linked, u and p are not offered and do nothing", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    expect(linkedLogin(forge.db, bob.id)).toBeUndefined();
    const plain = await shown("bob");
    expect(plain).not.toContain("unlink open-platform.sh");
    expect(plain).not.toContain("unlink parent forge");
    const pressed = await shown("bob", ["u", "p"]);
    expect(pressed).not.toContain("Unlink open-platform.sh login");
    expect(pressed).not.toContain("Unlink the parent forge?");
  });

  test("the screen shows the open-platform.sh link, and u unlinks it and says so on the bus", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    expect(await shown("bob")).toContain("open-platform.sh: not linked");
    expect(linkEdgeLogin(forge.db, bob, "octo").ok).toBe(true);
    const offered = await shown("bob");
    expect(offered).toContain("open-platform.sh: linked as octo");
    expect(offered).toContain("unlink open-platform.sh");
    expect(offered).not.toContain("unlink parent forge");
    const seen: string[] = [];
    const stop = forge.bus.subscribe((e) => seen.push(e.kind));
    const asked = await shown("bob", ["u"]);
    expect(asked).toContain("Unlink open-platform.sh login octo?");
    expect(asked).toContain("linked again from Settings on the web");
    expect(linkedLogin(forge.db, bob.id)).toBe("octo");
    expect(await shown("bob", ["u", "n"])).toContain("open-platform.sh: linked as octo");
    expect(await shown("bob", ["u", "esc"])).toContain("open-platform.sh: linked as octo");
    expect(linkedLogin(forge.db, bob.id)).toBe("octo");
    const after = await shown("bob", ["u", "y"]);
    stop();
    expect(after).toContain("open-platform.sh: not linked");
    expect(linkedLogin(forge.db, bob.id)).toBeUndefined();
    expect(seen).toContain("account.edge_unlinked");
  });

  test("the screen shows the parent forge link, and p unlinks it", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const issuer = "https://parent.example";
    forge.db.query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES (?1, 'sub1', ?2)").run(issuer, bob.id);
    forge.config.parentUrl = issuer;
    expect(await shown("bob")).toContain("parent.example: linked");
    // No password and no passkey: the link is the only way in, and p refuses.
    forge.db.query("UPDATE user SET password_hash = '' WHERE id = ?1").run(bob.id);
    expect(await shown("bob", ["p"])).toContain("Unlink the parent forge?");
    expect(await shown("bob", ["p", "n"])).toContain("parent.example: linked");
    expect(linkedParent(forge.db, bob.id, issuer)).toBe("sub1");
    const kept = await shown("bob", ["p", "y"]);
    expect(kept).toContain("parent.example: linked");
    expect(kept).toContain("Add a passkey or a password first");
    expect(linkedParent(forge.db, bob.id, issuer)).toBe("sub1");
    forge.db.query("UPDATE user SET password_hash = 'x' WHERE id = ?1").run(bob.id);
    const seen: string[] = [];
    const stop = forge.bus.subscribe((e) => seen.push(e.kind));
    const after = await shown("bob", ["p", "y"]);
    stop();
    expect(after).toContain("parent.example: not linked");
    expect(linkedParent(forge.db, bob.id, issuer)).toBeUndefined();
    expect(seen).toContain("account.parent_unlinked");
  });
});
