/**
 * The one backups line (#8867), said the same at both doors: /resilience and
 * the terminal's Resilience dialog read `snapshot/backups_line.ts`, so a forge
 * given no bucket says so in either, and one given a store names it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { BACKUPS_OFF, backupsLineOf } from "../src/snapshot/backups_line.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("backupsLineOf", () => {
  test("no store says backups are off, and why", () => {
    expect(backupsLineOf(undefined)).toEqual({ says: BACKUPS_OFF });
  });

  test("a store names where snapshots go", () => {
    expect(backupsLineOf({ where: "s3://bucket/forge" })).toEqual({
      where: "s3://bucket/forge",
      says: "Snapshots go to s3://bucket/forge.",
    });
  });

  test("a store whose where is empty or blank counts as none", () => {
    for (const where of ["", "   "]) expect(backupsLineOf({ where })).toEqual({ says: BACKUPS_OFF });
  });
});

describe("the backups line at both doors", () => {
  let dataDir: string;
  let forge: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-backups-line-"));
    forge = createApp({ dataDir, port: 0 });
    servers = await serve(forge);
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
  });

  afterAll(async () => {
    servers.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const login = async (): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: "username=alice&password=a-good-passphrase",
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };

  const webLine = async (): Promise<string> => {
    const res = await fetch(`${servers.url}/resilience`, { headers: { cookie: await login() } });
    expect(res.status).toBe(200);
    const page = await res.text();
    return page.slice(page.indexOf('id="backups-line"'), page.indexOf("</p>", page.indexOf('id="backups-line"')));
  };

  const terminalText = async (): Promise<string> => {
    const terminal = headlessTerminal(140, 40);
    const user = getUserByName(forge.db, "alice")!;
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    key("k", true);
    await settleApp(app);
    for (const ch of "Resilience") key(ch);
    await settleApp(app);
    key("enter");
    await settleApp(app);
    // The dialog wraps long lines: compare its words with the borders and breaks taken out.
    const text = app.screen.toText().replace(/[│\s]/g, "");
    app.stop();
    return text;
  };

  test("with no store, both say backups are off and why", async () => {
    expect(await webLine()).toContain(BACKUPS_OFF);
    expect(await terminalText()).toContain(BACKUPS_OFF.replace(/\s/g, ""));
  });

  test("with a store, both name where snapshots go and neither says off", async () => {
    const where = join(dataDir, "snapshots");
    const svc = startSnapshots(forge, dirStore(where), { version: "t", nightly: false });
    try {
      const web = await webLine();
      expect(web).toContain(`Snapshots go to ${where}.`);
      expect(web).not.toContain("Backups are off");
      const tty = await terminalText();
      expect(tty).toContain(`Snapshotsgoto${where}.`);
      expect(tty).not.toContain("Backupsareoff");
    } finally {
      await svc.stop();
    }
  });
});
