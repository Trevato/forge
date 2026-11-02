/** The terminal lists your bulk actions, and `u` undoes the selected one inside its day (#7937). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAsksBulk } from "../src/actions/asks_bulk.ts";
import { applyFleetIds, undoFleetOp, UNDO_WINDOW_MS } from "../src/actions/fleet.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Operation } from "../src/core/fleet_ops.ts";
import { getIssueById, setAssignee } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { bulkScreen, entry, whyNot } from "../src/tui/screens/bulk.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("bulk actions in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;

  function boot(user: User) {
    const terminal = headlessTerminal(140, 32);
    const { app } = createForgeApp(
      forge,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
      { terminal, exitHooks: false },
    );
    app.start();
    const key = (k: string, ctrl = false) =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      app,
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
      },
      push: async (user2: User) => {
        app.push(bulkScreen(new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: user2 }), app.ctx));
        await settleApp(app);
      },
      open: async () => {
        key("k", true);
        await settleApp(app);
        for (const ch of "Bulk actions") key(ch);
        key("enter");
        await settleApp(app);
      },
    };
  }
  const archived = (name: string): boolean => getRepo(forge.db, "alice", name)?.archivedAt != null;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-bulk-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error("user");
    }
    alice = getUserByName(forge.db, "alice")!;
    bob = getUserByName(forge.db, "bob")!;
    const made = await createRepo(forge, alice, { name: "solo", visibility: "public" });
    if (!made.ok) throw new Error("repo");
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an archive, then u wakes the repository; a second u is refused; bob never sees it", async () => {
    const op = await applyFleetIds(forge, alice, "repo", [getRepo(forge.db, "alice", "solo")!.id], "archive alice/solo", { verb: "archive", value: true });
    if (!op.ok) throw new Error(op.error.message);
    expect(archived("solo")).toBe(true);

    const other = boot(bob);
    try {
      await other.open();
      expect(other.text()).toContain("No bulk actions yet");
      expect(other.text()).not.toContain("archive");
    } finally {
      other.app.stop();
    }

    const h = boot(alice);
    try {
      await h.open();
      expect(h.text()).toContain("archive");
      expect(h.text()).toContain("1 row changed, 0 refused");
      expect(h.text()).toContain("u undoes");
      await h.press("u");
      await settleUntil(h.app, "undone");
      expect(archived("solo")).toBe(false);
      // The undo is a receipt of its own and heads the list; the original is below it.
      await h.press("j", "u");
      expect(h.text()).toContain("undone already");
      expect(archived("solo")).toBe(false);
      // Enter opens the rows: the receipt's before and after.
      await h.press("enter");
      expect(h.text()).toContain("alice/solo");
      expect(h.text()).toContain("→");
    } finally {
      h.app.stop();
    }
  });

  const archiveOne = async (name: string) => {
    const made = await createRepo(forge, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const op = await applyFleetIds(forge, alice, "repo", [made.value.id], `archive alice/${name}`, { verb: "archive", value: true });
    if (!op.ok) throw new Error(op.error.message);
    return op.value;
  };

  test("whyNot says why each kind of receipt is not undone", () => {
    const base: Operation = {
      id: "x", actorId: "a", actorName: "alice", query: "q", kind: "repo", verb: "archive",
      value: true, reversible: true, undoOf: null, undoneBy: null, createdAt: new Date().toISOString(), rows: [],
    };
    expect(whyNot(base)).toBe("");
    expect(whyNot({ ...base, undoneBy: "y" })).toContain("undone already");
    expect(whyNot({ ...base, undoOf: "y" })).toContain("is an undo");
    expect(whyNot({ ...base, reversible: false })).toContain("cannot be undone");
    const old = new Date(Date.now() - UNDO_WINDOW_MS - 60_000).toISOString();
    expect(whyNot({ ...base, createdAt: old })).toContain("day is over");
  });

  test("an expired receipt is refused on u and nothing changes", async () => {
    const op = await archiveOne("old");
    const old = new Date(Date.now() - UNDO_WINDOW_MS - 60_000).toISOString();
    forge.db.query("UPDATE fleet_operation SET created_at = ?1 WHERE id = ?2").run(old, op.id);
    const h = boot(alice);
    try {
      await h.open();
      await h.press("u");
      expect(h.text()).toContain("day is over");
      expect(getRepo(forge.db, "alice", "old")?.archivedAt).not.toBeNull();
    } finally {
      h.app.stop();
    }
  });

  test("u on an undo receipt does nothing", async () => {
    const op = await archiveOne("again");
    const undone = await undoFleetOp(forge, alice, op.id);
    if (!undone.ok) throw new Error(undone.error.message);
    const h = boot(alice);
    try {
      await h.open();
      await h.press("u");
      expect(h.text()).toContain("is an undo");
    } finally {
      h.app.stop();
    }
  });

  test("u undoes a bulk action on asks", async () => {
    const made = await createRepo(forge, alice, { name: "asky", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const issue = openIssue(forge, alice, made.value, { title: "Close me", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    setAssignee(forge.db, issue.value.id, alice.id);
    const done = await applyAsksBulk(forge, alice, "close", [`assigned:${issue.value.id}`], "done");
    if (!done.ok) throw new Error(done.error.message);
    expect(getIssueById(forge.db, issue.value.id)!.state).toBe("closed");
    const h = boot(alice);
    try {
      await h.open();
      expect(h.text()).toContain("close");
      await h.press("u");
      await settleUntil(h.app, "undone");
      expect(getIssueById(forge.db, issue.value.id)!.state).toBe("open");
    } finally {
      h.app.stop();
    }
  });

  test("a failed undo shows the action's own words and changes nothing", async () => {
    const op = await archiveOne("raced");
    const h = boot(alice);
    try {
      await h.open();
      // Listed as undoable, then undone elsewhere before u is pressed: the list is kept for a moment.
      const first = await undoFleetOp(forge, alice, op.id);
      if (!first.ok) throw new Error(first.error.message);
      await h.press("u");
      await settleUntil(h.app, "undone already");
      expect(archived("raced")).toBe(false);
    } finally {
      h.app.stop();
    }
  });

  test("another person cannot undo it, and an agent is not offered the screen", async () => {
    const op = await archiveOne("mine");
    const refused = await undoFleetOp(forge, bob, op.id);
    expect(refused.ok).toBe(false);
    expect(archived("mine")).toBe(true);

    const agent = { ...alice, kind: "agent" as const };
    const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: agent });
    expect(entry.offered(session)).toBe(false);
    expect(entry.offered(new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice }))).toBe(true);
    const h = boot(alice);
    try {
      await h.push(agent);
      expect(h.text()).toContain("Not available");
      expect(h.text()).not.toContain("archive");
    } finally {
      h.app.stop();
    }
  });
});
