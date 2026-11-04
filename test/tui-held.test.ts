/**
 * What the Later gate holds, in the terminal (#8700): `h` on a repository's
 * issues opens the held screen, the page's twin. A writer ticks and closes,
 * lifts and revives through the same actions; a reader is refused in the same
 * words and changes nothing; a private repository is not found; and the web
 * hears every write as the events its viewers already follow.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { THREAD_SAYS } from "../src/actions/thread_words.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { gateHolding } from "../src/core/gate_hold.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the Later gate, in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let repo: Repo;
  let idea: Issue;
  let other: Issue;
  let gate: Issue;

  const fresh = () => getRepoById(forge.db, repo.id)!;
  const current = (i: Issue) => getIssueById(forge.db, i.id)!;
  const held = (i: Issue) => gateHolding(forge.db, fresh(), current(i)) !== undefined;

  function boot(user: User | undefined) {
    const terminal = headlessTerminal(140, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        const ctrl = key.startsWith("ctrl+");
        app.dispatch({ type: "key", key: ctrl ? key.slice(5) : key, ctrl, alt: false, shift: false });
      }
      await settleApp(app);
    };
    const typeText = async (text: string) => {
      for (const ch of text) app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const toHeld = async (slug: string) => {
      await settleApp(app);
      await press("ctrl+k");
      await typeText("Held by the Later gate");
      await press("enter");
      await typeText(slug);
      await press("enter");
    };
    return { text: () => app.screen.toText(), press, typeText, toHeld, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-held-"));
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
    const alice = getUserByName(forge.db, "alice")!;
    const made = await createRepo(forge, alice, { name: "plan", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
    const open = (r: Repo, title: string): Issue => {
      const o = openIssue(forge, alice, r, { title });
      if (!o.ok) throw new Error(String(o.error));
      return o.value;
    };
    open(fresh(), "P0 Trust: be trusted");
    gate = open(fresh(), "Later gate: nothing behind this starts until the owner opens it");
    idea = open(fresh(), "Unchosen idea about colours");
    other = open(fresh(), "Another idea about fonts");
    for (const i of [idea, other]) linkIssue(forge, alice, fresh(), current(i), gate);
    const vault = await createRepo(forge, alice, { name: "vault", visibility: "private" });
    if (!vault.ok) throw new Error("vault");
    open(vault.value, "P0 Trust: be trusted");
    const g = open(vault.value, "Later gate: nothing behind this starts until the owner opens it");
    linkIssue(forge, alice, vault.value, open(vault.value, "Secret held idea"), g);
  }, 60_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader sees the candidates unticked, and is refused to lift or close", async () => {
    const h = boot(getUserByName(forge.db, "bob")!);
    await h.toHeld("alice/plan");
    expect(h.text()).toContain("Unchosen idea about colours");
    expect(h.text()).toContain("[ ] #");
    expect(h.text()).not.toContain("[x]");
    await h.press("l");
    expect(h.text()).toContain(THREAD_SAYS.planForbidden);
    await h.press("space", "A");
    expect(held(idea) && held(other)).toBe(true);
    expect(current(idea).state).toBe("open");
    h.stop();
  });

  test("a guest sees a public gate and changes nothing", async () => {
    const h = boot(undefined);
    await h.toHeld("alice/plan");
    expect(h.text()).toContain("Unchosen idea about colours");
    await h.press("l");
    expect(held(idea) && held(other)).toBe(true);
    await h.press("space", "A");
    expect(current(idea).state).toBe("open");
    h.stop();
  });

  test("a private repository is not found by a reader or a guest", async () => {
    for (const user of [getUserByName(forge.db, "bob"), undefined]) {
      const h = boot(user);
      await h.toHeld("alice/vault");
      expect(h.text()).toContain("not found");
      expect(h.text()).not.toContain("Secret held idea");
      h.stop();
    }
  });

  test("a writer ticks and closes, lifts and revives, and the web hears each write", async () => {
    const heard: string[] = [];
    const off = forge.bus.subscribe((e) => {
      if (e.repoId === repo.id) heard.push(`${e.kind}:${e.payload["number"]}`);
    });
    const h = boot(getUserByName(forge.db, "alice")!);
    await h.toHeld("alice/plan");
    // Nothing is ticked until the writer ticks: the first line is the newest.
    await h.press("space");
    expect(h.text()).toContain("[x]");
    await h.press("A");
    expect(current(other).state).toBe("closed");
    expect(current(idea).state).toBe("open");
    expect(heard).toContain(`issue.closed:${other.number}`);
    expect(h.text()).toContain("Closed by the review");
    // The closed one is listed after the candidates; Revive is `l` on it.
    await h.press("j", "l");
    expect(current(other).state).toBe("open");
    expect(held(other)).toBe(false);
    expect(heard).toContain(`issue.reopened:${other.number}`);
    expect(heard).toContain(`issue.unblocked:${other.number}`);
    // And lifting an open candidate lets it out.
    await h.press("k", "l");
    expect(held(idea)).toBe(false);
    off();
    h.stop();
  });
});
