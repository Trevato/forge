/** The operator guard in the terminal: a paused origin says so, with its reason, and `v` checks it again. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { CHECK_WORDS } from "../src/actions/origin_words.ts";
import { createOrigin, getOriginFor } from "../src/core/origins.ts";
import { lastGuardTry } from "../src/origins/credential.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("a paused origin in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let before: string | undefined;
  let userId = "";
  let originId = "";

  beforeAll(async () => {
    before = process.env.FORGE_ORIGIN_DENY_PUSH;
    process.env.FORGE_ORIGIN_DENY_PUSH = "system/*";
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-guard-"));
    forge = createApp({ dataDir, port: 0 });
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "dana",
      email: "dana@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    userId = made.value.id;
    const o = createOrigin(forge.db, dataDir, {
      userId: made.value.id,
      kind: "gitea",
      apiUrl: "http://127.0.0.1:9/api/v1",
      webUrl: "http://127.0.0.1:9",
      login: "dana",
      token: "t0ken-not-shown",
    });
    if (!o.ok) throw new Error(o.error);
    originId = o.value.id;
  });
  afterAll(async () => {
    if (before === undefined) delete process.env.FORGE_ORIGIN_DENY_PUSH;
    else process.env.FORGE_ORIGIN_DENY_PUSH = before;
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the list shows writes paused and its reason; v checks again and says what it found", async () => {
    const terminal = headlessTerminal(160, 32);
    const identity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, "dana")! } as TuiIdentity;
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = async (k: string, ctrl = false) => {
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      await settleApp(app);
    };
    try {
      await key("k", true);
      for (const ch of "Connected accounts") await key(ch);
      await key("enter");
      expect(app.screen.toText()).toContain("writes paused");
      expect(app.screen.toText()).toContain("Press v to check again");
      await key("v");
      for (let i = 0; i < 40 && getOriginFor(forge.db, userId, originId) !== undefined && lastGuardTry(forge, originId) === undefined; i++)
        await Bun.sleep(100);
      if (getOriginFor(forge.db, userId, originId) !== undefined && lastGuardTry(forge, originId) === undefined) throw new Error(`never came: still waiting while getOriginFor(forge.db, userId, originId) !== undefined && lastGuardTry(forge, originId) === undefined`);
      await key("k");
      expect(app.screen.toText()).toContain(CHECK_WORDS.unchecked.slice(0, 30));
    } finally {
      app.stop();
    }
  }, 20_000);
});
