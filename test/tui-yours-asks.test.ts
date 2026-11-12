/**
 * The terminal's On you leads with the week's asks as four numbers, as the
 * board's strip does (#8055): the viewer's own rows only, absent when all
 * four are 0.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { ASKS_WINDOW_DAYS, askMeasureWeek, asksMeasureWords } from "../src/core/ask_ledger.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

describe("terminal On you: the week's asks", () => {
  let dir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let repoId = "";
  let n = 0;

  const row = (viewer: User, how?: "acted" | "dismissed" | "expired", ageMs = 0) => {
    const now = new Date(Date.now() - ageMs).toISOString();
    forge.db.run(
      "INSERT INTO ask_ledger (id, viewer_id, ask_id, repo_id, kind, raised_at, ended_at, ended_how) VALUES (?,?,?,?,?,?,?,?)",
      [`r${++n}`, viewer.id, `a${n}`, repoId, "review", now, how === undefined ? null : now, how ?? null],
    );
  };

  const open = async (user: User | undefined, rows = 32) => {
    const { app } = createForgeApp(
      forge,
      { sshUsername: user?.username ?? "t", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", ...(user ? { user } : {}) },
      { terminal: headlessTerminal(200, rows), exitHooks: false },
    );
    app.start();
    await settleApp(app);
    const key = async (k: string) => {
      app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    return { app, key, text: () => app.screen.toText() };
  };

  const screen = async (user: User | undefined, rows = 32) => {
    const t = await open(user, rows);
    const text = t.text();
    t.app.stop();
    return text;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-yours-asks-"));
    forge = createApp({ dataDir: dir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
    const b = await signUp(forge, { username: "bob", email: "b@forge.test", password: "another-long-passphrase" }, { slot: fixtureSlot(forge) });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
    if (!r.ok) throw new Error("repo failed");
    repoId = r.value.id;
  });

  afterAll(async () => {
    forge.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("an empty ledger shows no line", async () => {
    expect(await screen(alice)).not.toContain("Asks, ");
  });

  test("askMeasureWeek counts a row just inside the window and not one just outside it", () => {
    const now = Date.parse("2026-01-10T12:00:00.000Z");
    const day = 86_400_000;
    const at = (ms: number) => new Date(ms).toISOString();
    const put = (id: string, ms: number) =>
      forge.db.run(
        "INSERT INTO ask_ledger (id, viewer_id, ask_id, repo_id, kind, raised_at, ended_at, ended_how) VALUES (?,?,?,?,?,?,?,?)",
        [id, bob.id, `a-${id}`, repoId, "review", at(ms), at(ms), "dismissed"],
      );
    put("edge-in", now - ASKS_WINDOW_DAYS * day + 1000);
    put("edge-out", now - ASKS_WINDOW_DAYS * day - 1000);
    expect(askMeasureWeek(forge.db, bob.id, now)).toEqual({ raised: 1, acted: 0, dismissed: 1, expired: 0 });
    forge.db.run("DELETE FROM ask_ledger WHERE id IN ('edge-in', 'edge-out')");
  });

  test("the four numbers are the week's, never older and never another viewer's", async () => {
    row(alice, "acted");
    row(alice, "acted");
    row(alice, "dismissed");
    row(alice, "expired");
    // Eight days old: outside the window, so the line leaves it out.
    row(alice, "acted", 8 * 86_400_000);
    row(bob, "dismissed");
    row(bob);
    const m = askMeasureWeek(forge.db, alice.id);
    expect(m).toEqual({ raised: 4, acted: 2, dismissed: 1, expired: 1 });
    expect(asksMeasureWords(m)).toBe(
      "Asks, 7 days: 4 raised · 2 acted on · 1 dismissed · 1 went by themselves",
    );
    expect(await screen(alice)).toContain(asksMeasureWords(m));
  });

  test("drawing reads the ledger on load, not on every frame: a later row waits for r", async () => {
    const t = await open(alice);
    try {
      const before = t.text();
      expect(before).toContain("4 raised");
      row(alice, "acted");
      t.app.frame();
      t.app.screen.toText();
      expect(t.text()).toContain("4 raised");
      await t.key("r");
      expect(t.text()).toContain("5 raised");
    } finally {
      t.app.stop();
    }
  });

  test("W offers the asks page on the web, and says so in the footer", async () => {
    const t = await open(alice);
    try {
      expect(t.text()).toContain("W asks on the web");
      await t.key("W");
      expect(t.text()).toContain("Asks is on the web at /asks");
    } finally {
      t.app.stop();
    }
  });

  test("a signed-out viewer, an agent and a three-row terminal get no line and no throw", async () => {
    expect(await screen(undefined)).not.toContain("Asks, ");
    expect(await screen({ ...alice, kind: "agent" })).not.toContain("Asks, ");
    expect(await screen(alice, 3)).not.toContain("Asks, ");
  });
});
