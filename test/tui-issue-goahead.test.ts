/** The issue screen's `g` (#7295): a person lets an issue pass a dropped blocker. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { heldBlockers } from "../src/core/dependencies.ts";
import { setIssueState, type Issue } from "../src/core/issues.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

describe("go ahead in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bot: User;
  let reader: User;
  let many: Issue;
  let manyBlockers: Issue[];
  let waiting: Issue;
  let blocker: Issue;

  function boot(user: User, guest = false) {
    const identity: TuiIdentity = guest
      ? { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:unknown" }
      : {
          sshUsername: user.username,
          remoteAddress: "127.0.0.1",
          fingerprint: "SHA256:test",
          user,
        };
    const { app } = createForgeApp(forge, identity, {
      terminal: headlessTerminal(140, 40),
      exitHooks: false,
    });
    app.start();
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys)
        app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    return { app, press, text: () => app.screen.toText() };
  }

  async function openWaiting(h: ReturnType<typeof boot>, title = "waiter", number = waiting.number): Promise<void> {
    await settleApp(h.app);
    await h.press("/");
    for (const ch of "beacon") await h.press(ch);
    await h.press("enter");
    await h.press("enter");
    await settleUntil(h.app, "alice/beacon");
    await h.press("i");
    await settleUntil(h.app, "Open 2");
    // Newest first: "pending" sits above "waiter".
    if (title === "waiter") await h.press("j");
    await h.press("enter");
    await settleUntil(h.app, `#${number}`);
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-goahead-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const made = await createRepo(forge, alice, { name: "beacon", visibility: "public" });
    if (!made.ok) throw new Error("repo failed");
    const w = await openIssue(forge, alice, made.value, { title: "waiter", body: "x" });
    const b = await openIssue(forge, alice, made.value, { title: "dropped one", body: "x" });
    if (!w.ok || !b.ok) throw new Error("issue failed");
    waiting = w.value;
    blocker = b.value;
    expect(linkIssue(forge, alice, made.value, waiting, blocker).ok).toBe(true);
    setIssueState(forge.db, blocker.id, "closed", "dropped");
    const u = await createUser(forge.db, {
      username: "bot",
      email: "bot@forge.test",
      agent: true,
      origin: "agent",
    });
    if (!u.ok) throw new Error("agent failed");
    bot = u.value;
    createAgentRow(forge.db, { userId: bot.id });
    addCrew(forge.db, made.value.id, bot.id);
    const r = await createUser(forge.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.test", password: "a-good-passphrase" });
    if (!r.ok) throw new Error("reader failed");
    reader = r.value;
    const m = await openIssue(forge, alice, made.value, { title: "pending", body: "x" });
    if (!m.ok) throw new Error("issue failed");
    many = m.value;
    manyBlockers = [];
    for (const title of ["first drop", "second drop"]) {
      const o = await openIssue(forge, alice, made.value, { title, body: "x" });
      if (!o.ok) throw new Error("issue failed");
      expect(linkIssue(forge, alice, made.value, many, o.value).ok).toBe(true);
      setIssueState(forge.db, o.value.id, "closed", "dropped");
      manyBlockers.push(o.value);
    }
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an agent on the crew is not offered `g`", async () => {
    const h = boot(bot);
    try {
      await openWaiting(h);
      expect(h.text()).not.toContain("go ahead");
      await h.press("g");
      expect(heldBlockers(forge.db, waiting.id)).toHaveLength(1);
    } finally {
      h.app.stop();
    }
  });

  test("a guest sees the line but is offered no `g` and no prompt", async () => {
    const h = boot(alice, true);
    try {
      await openWaiting(h);
      expect(h.text()).toContain(`#${blocker.number} (dropped)`);
      expect(h.text()).not.toContain("go ahead");
      await h.press("g");
      expect(h.text()).not.toContain("Let it go ahead?");
      expect(heldBlockers(forge.db, waiting.id)).toHaveLength(1);
    } finally {
      h.app.stop();
    }
  });

  test("a signed-in reader sees the line but is offered no `g` and no prompt", async () => {
    const h = boot(reader);
    try {
      await openWaiting(h);
      expect(h.text()).toContain(`#${blocker.number} (dropped)`);
      expect(h.text()).not.toContain("go ahead");
      await h.press("g");
      expect(h.text()).not.toContain("Let it go ahead?");
      expect(heldBlockers(forge.db, waiting.id)).toHaveLength(1);
    } finally {
      h.app.stop();
    }
  });

  test("enter on the default choice cancels and leaves the wait", async () => {
    const h = boot(alice);
    try {
      await openWaiting(h);
      await h.press("g");
      await settleUntil(h.app, "Let it go ahead?");
      await h.press("enter");
      expect(heldBlockers(forge.db, waiting.id)).toHaveLength(1);
      expect(h.text()).toContain(`#${blocker.number} (dropped)`);
    } finally {
      h.app.stop();
    }
  });

  test("the line names the dropped blocker, and `g` with a confirm clears it", async () => {
    const h = boot(alice);
    try {
      await openWaiting(h);
      expect(h.text()).toContain(`#${blocker.number} (dropped)`);
      expect(h.text()).toContain("go ahead");
      await h.press("g");
      await settleUntil(h.app, "Let it go ahead?");
      await h.press("left", "enter");
      await settleUntil(h.app, "may go ahead");
      expect(heldBlockers(forge.db, waiting.id)).toHaveLength(0);
      expect(h.text()).not.toContain("closed without being done");
    } finally {
      h.app.stop();
    }
  });

  test("an issue with nothing held never shows the line", async () => {
    const h = boot(alice);
    try {
      await openWaiting(h);
      expect(h.text()).not.toContain("closed without being done");
      await h.press("g");
      expect(h.text()).not.toContain("Let it go ahead?");
    } finally {
      h.app.stop();
    }
  });

  test("with several held, `g` lets a writer pick one and only that one is cleared", async () => {
    const h = boot(alice);
    try {
      await openWaiting(h, "pending", many.number);
      await h.press("g");
      await settleUntil(h.app, "Go ahead without");
      await h.press("enter");
      await settleUntil(h.app, "Let it go ahead?");
      expect(h.text()).toContain(`#${manyBlockers[0]!.number}`);
      await h.press("left", "enter");
      await settleUntil(h.app, "may go ahead");
      const left = heldBlockers(forge.db, many.id);
      expect(left.map((b) => b.id)).toEqual([manyBlockers[1]!.id]);
    } finally {
      h.app.stop();
    }
  });
});
