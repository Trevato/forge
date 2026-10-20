/**
 * A site admin grants and revokes an app's private destinations in the
 * terminal (#3469); the web and API door is `app-egress-grants.test.ts`.
 * Nobody else is offered the screen.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listEgressGrants } from "../src/core/egress_grants.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const ARM = "100.89.95.68:8101";

describe("egress grants in the terminal", () => {
  let dir: string;
  let app: App;
  let ada: User;
  let bob: User;
  let repo: Repo;

  const grants = () => listEgressGrants(app.db, repo.id).map((g) => g.destination);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "egress-admin-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await seedAdmin(app, { username: "ada", email: "ada@f.dev", password: "grants-are-exact" });
    if (!a.ok) throw new Error("admin");
    ada = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@f.dev", password: "grants-are-exact" });
    if (!b.ok) throw new Error("bob");
    bob = b.value;
    const made = await createRepo(app, ada, { name: "arm", visibility: "public", description: "" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const committed = await commitToBranch(app, ada, repo, {
      message: "Ask for the arm",
      files: [{ path: "forge.json", content: JSON.stringify({ app: { run: "bun run src/server.ts" }, egress: [ARM] }) }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  }, 60_000);
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  function boot(user: User) {
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
      { terminal: headlessTerminal(120, 40), exitHooks: false },
    );
    tui.start();
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys)
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const openAbout = async (): Promise<void> => {
      await settleApp(tui);
      await press("/");
      for (const ch of "arm") await press(ch);
      await press("enter", "enter");
      await settleUntil(tui, "ada/arm");
      await press("I");
      await settleUntil(tui, "clone (http)");
    };
    return { tui, press, openAbout, text: () => tui.screen.toText() };
  }

  test("an admin grants and revokes from About", async () => {
    const h = boot(ada);
    try {
      await h.openAbout();
      await h.press("e");
      await settleUntil(h.tui, "asked for, not granted");
      await h.press("g");
      await settleUntil(h.tui, "granted by ada");
      expect(grants()).toEqual([ARM]);
      await h.press("x");
      await settleUntil(h.tui, "asked for, not granted");
      expect(grants()).toEqual([]);
    } finally {
      h.tui.stop();
    }
  });

  test("a non-admin is not offered it, and the key does nothing", async () => {
    const h = boot(bob);
    try {
      await h.openAbout();
      await h.press("e");
      expect(h.text()).not.toContain("Private egress");
      expect(grants()).toEqual([]);
    } finally {
      h.tui.stop();
    }
  });
});
