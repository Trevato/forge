/**
 * Watching a milestone from the terminal (#7236): `w` on the limbs screen is
 * the same `watchMilestone` the page and MCP `watch` reach. A watched row
 * reads "watching", the person's feed then follows the milestone, and `w`
 * again takes both away. An agent has no feed and is told so in the words
 * MCP `watch` uses.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MILESTONE_WATCH_PERSON_ONLY } from "../src/actions/board_words.ts";
import { createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { isWatching } from "../src/core/watches.ts";
import { readFeed } from "../src/feed/feed.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("watch a milestone from the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let atlas: User;
  let repo: Repo;
  let release: Issue;
  let parts: Issue[];

  const fresh = (): Repo => getRepoById(forge.db, repo.id)!;
  const open = (title: string): Issue => {
    const opened = openIssue(forge, alice, fresh(), { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const inFeed = (who: User) =>
    readFeed(forge.db, who, { limit: 50 }).items.filter((i) => i.kind === "milestone");

  function boot(user: User) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) =>
      app.dispatch({ type: "key", key: k.startsWith("ctrl+") ? k.slice(5) : k, ctrl: k.startsWith("ctrl+"), alt: false, shift: false });
    const press = async (...keys: string[]) => {
      for (const k of keys) key(k);
      await settleApp(app);
    };
    const typeText = async (text: string) => {
      for (const ch of text) key(ch);
      await settleApp(app);
    };
    const toMilestones = async (spec = "alice/release") => {
      await settleApp(app);
      await press("ctrl+k");
      await typeText("Milestones in a repository");
      await press("enter");
      await typeText(spec);
      await press("enter");
    };
    return { text: () => app.screen.toText(), press, toMilestones, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-watch-"));
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
      if (!made.ok) throw new Error(made.error);
    }
    alice = getUserByName(forge.db, "alice")!;
    bob = getUserByName(forge.db, "bob")!;
    const agent = await createAgent(forge, alice, { username: "atlas" });
    if (!agent.ok) throw new Error(String(agent.error));
    atlas = getUserByName(forge.db, "atlas")!;
    const made = await createRepo(forge, alice, { name: "release", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
    release = open("Release 1.0");
    parts = [open("Part a"), open("Part b")];
    for (const p of parts) {
      const now = (i: Issue) => getIssueById(forge.db, i.id)!;
      const linked = linkIssue(forge, alice, fresh(), now(release), now(p));
      if (!linked.ok) throw new Error(String(linked.error));
    }
  }, 60_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("w watches: the row shows it and the feed follows; w again takes both away", async () => {
    const h = boot(bob);
    await h.toMilestones();
    expect(h.text()).toContain("Release 1.0");
    expect(h.text()).not.toContain("watching");
    expect(inFeed(bob)).toEqual([]);

    await h.press("w");
    expect(isWatching(forge.db, bob.id, release.id)).toBe(true);
    expect(h.text()).toMatch(/Release 1\.0.*watching/);
    // The feed says a watched milestone once there is news: here, it lands.
    await Bun.sleep(5);
    for (const p of parts) {
      const closed = setIssueState(forge, alice, fresh(), getIssueById(forge.db, p.id)!, "closed");
      if (!closed.ok) throw new Error(String(closed.error));
    }
    const items = inFeed(bob);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(`milestone:${release.id}:landed`);

    await h.press("w");
    expect(isWatching(forge.db, bob.id, release.id)).toBe(false);
    expect(h.text()).not.toMatch(/Release 1\.0.*watching/);
    expect(inFeed(bob)).toEqual([]);
    h.stop();
  });

  test("an agent is refused in MCP watch's words, and nothing is written", async () => {
    const h = boot(atlas);
    await h.toMilestones();
    expect(h.text()).toContain("Release 1.0");
    await h.press("w");
    expect(h.text()).toContain(MILESTONE_WATCH_PERSON_ONLY);
    expect(isWatching(forge.db, atlas.id, release.id)).toBe(false);
    expect(h.text()).not.toMatch(/Release 1\.0.*watching/);
    h.stop();
  });

  test("a repository made private under an open screen is not watched", async () => {
    const made = await createRepo(forge, alice, { name: "closing", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const r = made.value;
    const opened = (title: string): Issue => {
      const o = openIssue(forge, alice, getRepoById(forge.db, r.id)!, { title });
      if (!o.ok) throw new Error(String(o.error));
      return o.value;
    };
    const gate = opened("Gate 2.0");
    const leaf = opened("Leaf");
    const linked = linkIssue(forge, alice, getRepoById(forge.db, r.id)!, gate, leaf);
    if (!linked.ok) throw new Error(String(linked.error));

    const h = boot(bob);
    await h.toMilestones("alice/closing");
    expect(h.text()).toContain("Gate 2.0");
    const sealed = await updateRepoSettings(forge, alice, getRepoById(forge.db, r.id)!, { visibility: "private" });
    if (!sealed.ok) throw new Error(String(sealed.error));
    await h.press("w");
    expect(h.text()).toContain("no milestone to watch here");
    expect(isWatching(forge.db, bob.id, gate.id)).toBe(false);
    h.stop();
  });
});
