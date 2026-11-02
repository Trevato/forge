/**
 * A site admin grants and revokes an app's private destinations in the
 * terminal (#3469); the web and API door is `app-egress-grants.test.ts`.
 * Nobody else is offered the screen.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listEgressGrants } from "../src/core/egress_grants.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { meterEgress, NPM_REGISTRY, recordEgress, resetEgressTotals, startEgress } from "../src/apps/egress.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settlePalette, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();
// Every wait inside settles for up to 20s; bun's 5s test default would cut a loaded check short.
setDefaultTimeout(60_000);

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
  // A grant left by one test must not decide the next.
  beforeEach(() => {
    app.db.query("DELETE FROM egress_grant WHERE repo_id = ?1").run(repo.id);
  });
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
      // The palette searches twice, at 120ms and live at 400ms, and redraws the list each time;
      // enter before the second can open a row the redraw moves.
      await settlePalette(tui);
      await settleUntil(tui, "ada/arm");
      await press("enter", "enter");
      // "ada/arm" is on screen from the palette and the dashboard before the repository opens; its one-line file is the sign it has.
      await settleUntil(tui, "1 line");
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
      await settleUntil(h.tui, "reach");
      expect(grants()).toEqual([]);
      await h.press("y");
      await settleUntil(h.tui, "granted by ada");
      expect(grants()).toEqual([ARM]);
      await h.press("x");
      await settleUntil(h.tui, "Revoke");
      expect(grants()).toEqual([ARM]);
      await h.press("y");
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

  test("an admin sees the open egress connections from About; a non-admin does not", async () => {
    const camera = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const listen = probe.port;
    probe.stop(true);
    const egress = startEgress(
      { tcp: listen },
      { hosts: [], origins: [{ host: "127.0.0.1", port: camera.port }], label: "app:cam/main" },
    );
    let reply = "";
    const client = await Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port: listen,
      socket: { data: (_s, c) => void (reply += new TextDecoder().decode(c)) },
    });
    client.write(`CONNECT 127.0.0.1:${camera.port} HTTP/1.1\r\n\r\n`);
    while (!reply.includes("200")) await Bun.sleep(10);
    resetEgressTotals();
    const meter = meterEgress("check:r", repo.id);
    recordEgress("check:r", NPM_REGISTRY, 3_000_000, 0);
    meter.stop();
    const admin = boot(ada);
    const other = boot(bob);
    try {
      await admin.openAbout();
      await admin.press("c");
      await settleUntil(admin.tui, "app:cam/main");
      expect(admin.text()).toContain(`127.0.0.1:${camera.port} · 1 open`);
      // The registry's hour, as the Capacity page and MCP `capacity` read it (#7546).
      // …and the repository it sent most to, from the same `egressHour` (#8382).
      expect(admin.text()).toContain("The npm registry sent 2.9 MiB over the last hour, most to ada/arm (2.9 MiB).");
      await other.openAbout();
      await other.press("c");
      expect(other.text()).not.toContain("Egress connections");
      expect(other.text()).not.toContain("app:cam/main");
      expect(other.text()).not.toContain("npm registry");
    } finally {
      resetEgressTotals();
      admin.tui.stop();
      other.tui.stop();
      client.terminate();
      egress.close();
      camera.stop(true);
    }
  });
});
