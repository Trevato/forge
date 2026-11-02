/**
 * Next up in the terminal (#8694): the ranked list, and Top, Up, Down and Not
 * now as keys, through the palette against a real forge. A reader sees the
 * order and has no keys to change it, a guest sees nothing private, and a
 * move made here reaches the bus as `issue.ranked`, so a page open on the web
 * hears it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { rankIssue } from "../src/actions/next.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssue } from "../src/core/issues.ts";
import { nextUp } from "../src/core/next_up.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("next up in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let vault: Repo;
  const n: Record<string, number> = {};

  const open = (r: Repo, title: string): number => {
    const o = openIssue(forge, alice, r, { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value.number;
  };
  const order = (r: Repo = repo): number[] => nextUp(forge.db, r).rows.map((x) => x.issue.number);

  function boot(user?: User) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys)
        app.dispatch({ type: "key", key: key.startsWith("ctrl+") ? key.slice(5) : key, ctrl: key.startsWith("ctrl+"), alt: false, shift: false });
      await settleApp(app);
    };
    const typeText = async (text: string) => {
      for (const ch of text) app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const toNext = async (spec: string) => {
      await settleApp(app);
      await press("ctrl+k");
      await typeText("Next up in a repository");
      await press("enter");
      await typeText(spec);
      await press("enter");
    };
    return { text: () => app.screen.toText(), press, toNext, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-next-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, first] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed", trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
    }
    alice = getUserByName(forge.db, "alice")!;
    bob = getUserByName(forge.db, "bob")!;
    const made = await createRepo(forge, alice, { name: "plan", visibility: "public" });
    const sealed = await createRepo(forge, alice, { name: "vault", visibility: "private" });
    if (!made.ok || !sealed.ok) throw new Error("repo");
    repo = made.value;
    vault = sealed.value;
    n.gate = open(repo, "Later gate: not now");
    for (const name of ["a", "b", "c"]) n[name] = open(repo, `Work ${name}`);
    addDependency(forge.db, getIssue(forge.db, repo.id, n.c!)!, getIssue(forge.db, repo.id, n.gate!)!, alice.id);
    open(vault, "Secret work");
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer moves a row with the keys, each saves at once, and the web hears it", async () => {
    const heard: string[] = [];
    const off = forge.bus.subscribe((e) => {
      if (e.kind === "issue.ranked" && e.repoId === repo.id) heard.push(e.kind);
    });
    const h = boot(alice);
    await h.toNext("alice/plan");
    expect(h.text()).toContain("Work a");
    expect(h.text()).toContain("Enabler");
    const before = order();
    expect(before).toEqual([n.a!, n.b!]);

    // Down, then Top on the row the cursor followed.
    await h.press("d");
    expect(order()[1]).toBe(before[0]!);
    expect(heard).toHaveLength(1);
    await h.press("t");
    expect(order()[0]).toBe(before[0]!);
    expect(heard).toHaveLength(2);

    // Not now puts the row behind the Later gate.
    const first = order()[0]!;
    await h.press("n");
    expect(order()).not.toContain(first);
    expect(nextUp(forge.db, repo).notNow.map((r) => r.issue.number)).toContain(first);

    // Top on a Not now row lifts it again, from the web or here.
    expect(rankIssue(forge, alice, repo, first, { to: "top" }).ok).toBe(true);
    off();
    h.stop();
  });

  test("a move made elsewhere reorders the open list without a key", async () => {
    const h = boot(alice);
    await h.toNext("alice/plan");
    const last = order().at(-1)!;
    expect(rankIssue(forge, alice, repo, last, { to: "top" }).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    await h.press("j", "k");
    expect(h.text()).toMatch(new RegExp(`1\\. #${last} `));
    h.stop();
  });

  test("a reader sees the order and the keys change nothing", async () => {
    const h = boot(bob);
    await h.toNext("alice/plan");
    expect(h.text()).toContain("you can read this order, not change it");
    const before = order();
    await h.press("j", "t", "n", "d");
    expect(order()).toEqual(before);
    h.stop();
  });

  test("a guest sees nothing private", async () => {
    const h = boot(undefined);
    await h.toNext("alice/vault");
    expect(h.text()).not.toContain("Secret work");
    h.stop();
  });
});
