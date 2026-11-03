/**
 * The terminal's On you answers to the same mutes and the same one-move verbs
 * as the web card (#1320): muted repositories are said, never listed, rows can
 * be marked and given close / mute / ship through `applyAsksBulk`, and the
 * latest set can be undone inside its day.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { chipsOf, setChip } from "../src/core/feed_chips.ts";
import { createIssue, getIssue } from "../src/core/issues.ts";
import { mutedRepos, recordInteraction } from "../src/core/interactions.ts";
import { setCapacity, storedCapacity } from "../src/core/capacity.ts";
import { hunt } from "../src/crew/sentinel.ts";
import { markVerified } from "../src/core/verify.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

describe("terminal On you: mutes and many in one move", () => {
  let dir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let lamp: Repo;
  let vault: Repo;
  let paint: Repo;

  const issueIn = (repo: Repo, title: string, to: User = alice) => {
    const made = openIssue(forge, alice, repo, { title });
    if (!made.ok) throw new Error("issue failed");
    const set = assignIssue(forge, alice, repo, made.value, to);
    if (!set.ok) throw new Error("assign failed");
    return made.value;
  };

  /** Alice's terminal, focused on On you. */
  async function boot() {
    const terminal = headlessTerminal(200, 32);
    const { app } = createForgeApp(
      forge,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
      { terminal, exitHooks: false },
    );
    app.start();
    const settle = () => settleApp(app);
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settle();
      }
    };
    await settle();
    await press("tab");
    return {
      press,
      text: () => app.screen.toText(),
      type: async (s: string) => {
        for (const ch of s) await press(ch);
      },
      stop: () => app.stop(),
    };
  }

  const state = (repo: Repo, n: number) => getIssue(forge.db, repo.id, n)?.state;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-onyou-"));
    forge = createApp({ dataDir: dir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
    const b = await signUp(forge, { username: "bob", email: "b@forge.test", password: "another-long-passphrase" }, { slot: fixtureSlot(forge) });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    markVerified(forge.db, bob.id, new Date().toISOString());
    promote(forge.db, bob);
    const mk = async (name: string) => {
      const r = await createRepo(forge, alice, { name, visibility: "public" });
      if (!r.ok) throw new Error("repo failed");
      return r.value;
    };
    lamp = await mk("lamp");
    vault = await mk("vault");
    paint = await mk("paint");
  });

  afterAll(async () => {
    forge.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("marked rows are closed with one reason, then undone", async () => {
    issueIn(lamp, "Lamp flickers");
    issueIn(lamp, "Lamp hums");
    const h = await boot();
    expect(h.text()).toContain("Lamp flickers");
    await h.press("space", "j", "space");
    expect(h.text()).toContain("2 marked");
    await h.press("x");
    await h.type("done for now");
    await h.press("enter");
    expect(state(lamp, 1)).toBe("closed");
    expect(state(lamp, 2)).toBe("closed");
    expect(h.text()).not.toContain("Lamp hums");
    expect(h.text()).toContain("u undo");
    await h.press("u");
    expect(state(lamp, 1)).toBe("open");
    expect(state(lamp, 2)).toBe("open");
    expect(h.text()).toContain("Lamp hums");
    h.stop();
  });

  test("mute hides the repository, says so, and listen again brings it back", async () => {
    issueIn(vault, "Vault door sticks");
    const h = await boot();
    expect(h.text()).toContain("Vault door sticks");
    await h.press("m");
    expect(mutedRepos(forge.db, alice.id).size).toBe(1);
    expect(h.text()).toMatch(/1 repositor(y|ies) muted/);
    await h.press("L");
    expect(mutedRepos(forge.db, alice.id).size).toBe(0);
    expect(h.text()).not.toContain("repository muted");
    h.stop();
  });

  test("chips: a key switches a kind off for the inbox and the web, and back", async () => {
    const h = await boot();
    expect(chipsOf(forge.db, alice.id).kinds.size).toBe(0);
    await h.press("2");
    expect(chipsOf(forge.db, alice.id).kinds.has("decisions")).toBe(true);
    expect(h.text()).toContain("off: decisions");
    await h.press("2");
    expect(chipsOf(forge.db, alice.id).kinds.size).toBe(0);
    setChip(forge.db, alice.id, { kind: "person", value: bob.id }, true);
    await h.press("P");
    expect(chipsOf(forge.db, alice.id).people.size).toBe(0);
    h.stop();
  });

  test("chips: h hides the author of the row under the cursor, never yourself", async () => {
    const theirs = openIssue(forge, bob, lamp, { title: "Bob's flicker" });
    if (!theirs.ok) throw new Error("issue failed");
    assignIssue(forge, alice, lamp, theirs.value, alice);
    const own = issueIn(lamp, "Alice's own hum");
    const h = await boot();
    expect(h.text()).toContain("Bob's flicker");
    // Walk the rows pressing h: alice's own are refused, bob's goes.
    for (let i = 0; i < 12; i++) {
      await h.press("h");
      if (chipsOf(forge.db, alice.id).people.size > 0) break;
      await h.press("j");
    }
    const people = chipsOf(forge.db, alice.id).people;
    expect(people.has(alice.id)).toBe(false);
    expect(people.has(bob.id)).toBe(true);
    expect(h.text()).not.toContain("Bob's flicker");
    await h.press("P");
    expect(h.text()).toContain("Bob's flicker");
    h.stop();
    void own;
  });

  test("a repository muted elsewhere (the web) is hidden here", async () => {
    issueIn(paint, "Paint peels");
    const h0 = await boot();
    expect(h0.text()).toContain("Paint peels");
    h0.stop();
    recordInteraction(forge.db, {
      viewerId: alice.id,
      itemId: `repo:${paint.id}`,
      kind: "muted",
      repoId: paint.id,
      actorId: null,
    });
    const h = await boot();
    expect(h.text()).not.toContain("Paint peels");
    expect(h.text()).toContain("1 repository muted");
    await h.press("L");
    expect(h.text()).toContain("Paint peels");
    h.stop();
  });

  test("listen again clears a muted repository with nothing assigned to you", async () => {
    const quiet = await createRepo(forge, alice, { name: "quiet", visibility: "public" });
    if (!quiet.ok) throw new Error("repo failed");
    recordInteraction(forge.db, {
      viewerId: alice.id,
      itemId: `repo:${quiet.value.id}`,
      kind: "muted",
      repoId: quiet.value.id,
      actorId: null,
    });
    const h = await boot();
    expect(h.text()).toContain("1 repository muted");
    await h.press("L");
    expect(mutedRepos(forge.db, alice.id).has(quiet.value.id)).toBe(false);
    expect(h.text()).not.toContain("repository muted");
    h.stop();
  });

  test("ship refuses what cannot ship, inline", async () => {
    // Bob's repository: alice may read it and was assigned, but cannot close it.
    const r = await createRepo(forge, bob, { name: "bobs", visibility: "public" });
    if (!r.ok) throw new Error("repo failed");
    const made = openIssue(forge, bob, r.value, { title: "Bob's chore" });
    if (!made.ok) throw new Error("issue failed");
    const set = assignIssue(forge, bob, r.value, made.value, alice);
    if (!set.ok) throw new Error("assign failed");
    const h = await boot();
    // Find the row, whatever the order.
    for (let i = 0; i < 8 && !/> .*Bob's chore|▸.*Bob's chore/.test(h.text()); i++) await h.press("j");
    if (!/> .*Bob's chore|▸.*Bob's chore/.test(h.text())) throw new Error(`never came: still waiting while !/> .*Bob's chore|▸.*Bob's chore/.test(h.text())`);
    await h.press("S", "right", "enter");
    expect(state(r.value, 1)).toBe("open");
    expect(h.text()).toContain("1 refused (bob/bobs#1: not a change)");
    h.stop();
  });

  // The sentinel files no setting now (#3269); one it filed before may still be open.
  const legacySetting = (key: string): void => {
    const made = createIssue(forge.db, {
      repoId: lamp.id,
      authorId: alice.id,
      title: `Sentinel: Setting ${key} has been away from its default for 10 days`,
      body: `${key} is away`,
    });
    if (!made.ok) throw new Error(made.error);
    forge.db
      .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES (?1, ?2, '', 'a', 'a')")
      .run(`setting:${key}`, made.value.id);
  };

  test("a legacy setting finding has no card, and K and B leave the setting as it is", async () => {
    setCapacity(forge.db, "cells.egress", "report", alice.id);
    legacySetting("cells.egress");
    const h = await boot();
    for (let i = 0; i < 20; i++) await h.press("j");
    expect(h.text()).not.toContain("setting cells.egress");
    await h.press("B");
    await h.press("K");
    expect(storedCapacity(forge.db, "cells.egress")).toBe("report");
    h.stop();
    forge.db.query("DELETE FROM forge_setting").run();
    forge.db.query("DELETE FROM sentinel_finding").run();
  });

  test("B with no wave put aside does nothing", async () => {
    hunt(forge, "alice/lamp");
    const h = await boot();
    await h.press("B");
    expect(h.text()).not.toContain("wave back");
    expect(h.text()).not.toContain("waves back");
    h.stop();
  });
});
