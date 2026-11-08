/** Connected origins in the terminal: listed, disconnected after a confirm, never offered to a guest. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { syncOriginNow, disconnectOrigin } from "../src/actions/origins.ts";
import { NO_SUCH_ORIGIN } from "../src/actions/origin_words.ts";
import { createOrigin, listOrigins } from "../src/core/origins.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("connected origins in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let aliceId = "";

  function boot(identity: TuiIdentity) {
    const terminal = headlessTerminal(140, 32);
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
      },
      ctrl: async (k: string) => {
        key(k, true);
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Connected origins");
    return h;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-origins-"));
    forge = createApp({ dataDir, port: 0 });
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    aliceId = made.value.id;
    const o = createOrigin(forge.db, dataDir, {
      userId: aliceId,
      kind: "gitea",
      apiUrl: "https://git.example.test/api/v1",
      webUrl: "https://git.example.test",
      login: "alicia",
      token: "t0ken-not-shown",
    });
    if (!o.ok) throw new Error(o.error);
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const alice = () => ({ sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, "alice")! }) as TuiIdentity;

  test("the list shows the seeded origin, and never its token", async () => {
    const h = await open(boot(alice()));
    try {
      await h.press("enter");
      expect(h.text()).toContain("git.example.test");
      expect(h.text()).toContain("alicia");
      expect(h.text()).toContain("0 repositories");
      expect(h.text()).toContain("never synced");
      expect(h.text()).not.toContain("t0ken-not-shown");
    } finally {
      h.stop();
    }
  });

  test("s syncs the selected origin and says how many repositories it found", async () => {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const o = createOrigin(forge.db, dataDir, {
      userId: made.value.id,
      kind: "gitea",
      apiUrl: "http://127.0.0.1:9/api/v1",
      webUrl: "http://127.0.0.1:9",
      login: "carol",
      token: "t0ken-not-shown",
    });
    if (!o.ok) throw new Error(o.error);
    const h = boot({ sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, "carol")! } as TuiIdentity);
    try {
      await h.ctrl("k");
      await h.type("Connected origins");
      await h.press("enter");
      expect(listOrigins(forge.db, made.value.id)[0]!.lastError).toBe("");
      await h.press("s");
      for (let i = 0; i < 40 && listOrigins(forge.db, made.value.id)[0]!.lastSyncAt === null; i++) await Bun.sleep(100);
      if (listOrigins(forge.db, made.value.id)[0]!.lastSyncAt === null) throw new Error(`never came: still waiting while listOrigins(forge.db, made.value.id)[0]!.lastSyncAt === null`);
      await h.press("k");
      expect(listOrigins(forge.db, made.value.id)[0]!.lastSyncAt).not.toBeNull();
      expect(h.text()).toContain("Synced 0 repositories.");
      expect(h.text()).not.toContain("never synced");
    } finally {
      h.stop();
    }
  });

  test("s with no origin does nothing", async () => {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const h = await open(boot({ sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, "bob")! } as TuiIdentity));
    try {
      await h.press("enter");
      expect(h.text()).toContain("No origin connected");
      await h.press("s");
      expect(h.text()).not.toContain("Syncing");
    } finally {
      h.stop();
    }
  });

  test("another user's origin id is not found, to sync or to disconnect", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const id = listOrigins(forge.db, aliceId)[0]!.id;
    const synced = await syncOriginNow(forge, bob, id);
    expect(synced.ok).toBe(false);
    if (!synced.ok) expect(synced.error).toBe("not_found");
    const gone = await disconnectOrigin(forge, bob, id);
    expect(gone.ok).toBe(false);
    expect(NO_SUCH_ORIGIN).toBe("No such origin.");
    expect(listOrigins(forge.db, aliceId)).toHaveLength(1);
  });

  test("an agent is not offered the entry", async () => {
    const h = boot({ ...alice(), user: { ...getUserByName(forge.db, "alice")!, kind: "agent" } } as TuiIdentity);
    try {
      await h.ctrl("k");
      await h.type("Connected origins");
      expect(h.text()).not.toContain("the hosts your mirrors come from");
    } finally {
      h.stop();
    }
  });

  test("d then Cancel keeps the origin; d then Disconnect removes it", async () => {
    const h = await open(boot(alice()));
    try {
      await h.press("enter");
      await h.press("d");
      expect(h.text()).toContain("Disconnect this origin?");
      expect(h.text()).toContain("Cancel");
      await h.press("enter");
      expect(listOrigins(forge.db, aliceId)).toHaveLength(1);
      expect(h.text()).toContain("git.example.test");

      await h.press("d");
      await h.press("right");
      await h.press("enter");
      expect(listOrigins(forge.db, aliceId)).toHaveLength(0);
      expect(h.text()).toContain("Disconnected. Revoke the token on the origin too");
      expect(h.text()).not.toContain("alicia");
    } finally {
      h.stop();
    }
  });

  test("a guest is not offered the entry", async () => {
    const h = boot({ sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:unknown" });
    try {
      await h.ctrl("k");
      await h.type("Connected origins");
      expect(h.text()).not.toContain("the hosts your mirrors come from");
    } finally {
      h.stop();
    }
  });
});
