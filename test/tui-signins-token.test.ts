/**
 * The sign-ins screen revokes one of your tokens with `d` after a confirm (#7441).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { addKey, parseAuthorizedKey } from "../src/core/keys.ts";
import { createToken, verifyToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { signInsOf } from "../src/tui/screens/signins.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo terminal-test";

/** `d` on a token row revokes it after a confirm; no frame ever holds a token value. */
describe("revoking a token from the sign-ins screen", () => {
  let dataDir: string;
  let forge: Forge;
  let ci: { id: string; token: string };
  let deploy: { id: string; token: string };
  let bobs: { id: string; token: string };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-signins-token-"));
    forge = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob"]) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: false,
      });
      if (!made.ok) throw new Error(made.error);
    }
    const alice = getUserByName(forge.db, "alice")!;
    const bob = getUserByName(forge.db, "bob")!;
    const parsed = parseAuthorizedKey(KEY);
    if (!parsed.ok) throw new Error(parsed.error);
    const added = addKey(forge.db, alice.id, "alice-laptop-key", parsed.value);
    if (!added.ok) throw new Error(added.error);
    ci = createToken(forge.db, alice.id, "alice-ci", "ro");
    deploy = createToken(forge.db, alice.id, "alice-deploy", "rw");
    bobs = createToken(forge.db, bob.id, "bob-box", "ro");
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function boot() {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, "alice")!;
    const { app } = createForgeApp(
      forge,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    app.start();
    const frames: string[] = [];
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => {
        const t = app.screen.toText();
        frames.push(t);
        return t;
      },
      frames,
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
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

  test("a cancelled confirm changes nothing; yes revokes only that token", async () => {
    const seen: { kind: string; payload: unknown }[] = [];
    const stop = forge.bus.subscribe((e) => seen.push({ kind: e.kind, payload: e.payload }));
    const h = boot();
    await h.open();
    const alice = getUserByName(forge.db, "alice")!;
    const names = signInsOf(new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice })).map((s) => s.where);
    const at = names.indexOf("alice-ci · ro");
    expect(at).toBeGreaterThanOrEqual(0);
    await h.press(...Array(at).fill("j"), "d");
    expect(h.text()).toContain("Revoke alice-ci (ro)? It stops working at once.");
    await h.press("enter"); // Keep is the default
    expect(verifyToken(forge.db, ci.token).ok).toBe(true);
    expect(seen.filter((e) => e.kind === "token.deleted")).toEqual([]);
    expect(h.text()).toContain("alice-ci · ro");
    await h.press("d", "right", "enter");
    expect(h.text()).toContain("Revoked that token.");
    expect(verifyToken(forge.db, ci.token).ok).toBe(false);
    expect(seen.filter((e) => e.kind === "token.deleted").map((e) => e.payload)).toEqual([{ tokenId: ci.id }]);
    stop();
    expect(verifyToken(forge.db, deploy.token).ok).toBe(true);
    expect(verifyToken(forge.db, bobs.token).ok).toBe(true);
    expect(h.text()).not.toContain("alice-ci · ro");
    for (const frame of h.frames) for (const t of [ci, deploy, bobs]) expect(frame).not.toContain(t.token);
    h.stop();
  });
});
