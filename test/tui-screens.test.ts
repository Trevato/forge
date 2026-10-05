/**
 * The terminal UI, driven headlessly against a real forge: `createApp` in a
 * temp directory, seeded through the actions, and every assertion made
 * against the cell grid the renderer actually produced.
 *
 * The adversarial cases carry the weight. A TUI session is a *client*, so the
 * questions worth asking are the ones invariant 6 and 9 answer everywhere
 * else: can a guest see a private repo, does a mutation really go through the
 * action (and therefore the outbox), and does a defect in a screen end the
 * session rather than the process.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createLabel,
  createRepo,
} from "../src/actions/repos.ts";
import { addSshKey, signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssue, listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { getUserSetting } from "../src/core/settings.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { parseGitCommand, splitCommand } from "../src/git/smart-ssh.ts";
import { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { sshTerminal } from "../src/tui/ssh.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { SshSession } from "../src/ssh/channels.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

// A real ed25519 authorized_keys line, so key parsing is exercised for real.
const KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo terminal-test";
const OTHER_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPFmRRUt8Kt1FnvSHCFtMQ8kAM3ZRCEqB4kUgKhVBoWt other";

interface Harness {
  app: App;
  terminal: ReturnType<typeof headlessTerminal>;
  text(): string;
  press(...keys: string[]): Promise<void>;
  typeText(text: string): Promise<void>;
  settle(): Promise<void>;
  stop(): void;
}

function boot(
  forge: Forge,
  identity: TuiIdentity,
  cols = 120,
  rows = 32,
): Harness {
  const terminal = headlessTerminal(cols, rows);
  const { app } = createForgeApp(forge, identity, {
    terminal,
    exitHooks: false,
  });
  app.start();
  // Quiescence, not a stopwatch — see test/helpers/tui.ts for why the old
  // sleep-and-hope version was the flake in this file.
  const settle = (): Promise<void> => settleApp(app);
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) {
      const ctrl = key.startsWith("ctrl+");
      app.dispatch({
        type: "key",
        key: ctrl ? key.slice(5) : key,
        ctrl,
        alt: false,
        shift: false,
      });
    }
    await settle();
  };
  return {
    app,
    terminal,
    text: () => app.screen.toText(),
    async press(...keys) {
      // "ctrl+d" arrives as one chord, so split it here rather than at every
      // call site.
      for (const key of keys) {
        if (key.startsWith("ctrl+"))
          app.dispatch({
            type: "key",
            key: key.slice(5),
            ctrl: true,
            alt: false,
            shift: false,
          });
        else await press(key);
      }
      await settle();
    },
    async typeText(text) {
      for (const ch of text)
        app.dispatch({
          type: "key",
          key: ch,
          ctrl: false,
          alt: false,
          shift: false,
        });
      await settle();
    },
    settle,
    stop: () => app.stop(),
  };
}

describe("the terminal UI, against a real forge", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let open: Repo;

  const asAlice = (): TuiIdentity => ({
    sshUsername: "alice",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    user: alice,
  });
  const asGuest = (): TuiIdentity => ({
    sshUsername: "git",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:unknown",
    publicKey: KEY_LINE,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    const b = await signUp(forge, {
      username: "bob",
      email: "bob@forge.test",
      password: "another-long-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;

    const o = await createRepo(forge, alice, {
      name: "lighthouse",
      visibility: "public",
      description: "a public repo",
    });
    const s = await createRepo(forge, alice, {
      name: "vault",
      visibility: "private",
    });
    if (!o.ok || !s.ok) throw new Error("repo creation failed");
    open = o.value;

    await commitToBranch(forge, alice, open, {
      message: "seed",
      files: [
        { path: "README.md", content: "# Lighthouse\n\nA beacon.\n" },
        { path: "src/main.ts", content: "export const one = 1;\n" },
      ],
    });
    await commitToBranch(forge, alice, open, {
      branch: "feature",
      message: "add two",
      files: [{ path: "src/two.ts", content: "export const two = 2;\n" }],
    });
    await commitToBranch(forge, alice, open, {
      branch: "clash",
      message: "clash",
      files: [{ path: "src/main.ts", content: "export const one = 111;\n" }],
    });
    await commitToBranch(forge, alice, open, {
      message: "move main",
      files: [{ path: "src/main.ts", content: "export const one = 2;\n" }],
    });

    openIssue(forge, alice, open, {
      title: "The lamp flickers",
      body: "It flickers at dusk.",
    });
    openIssue(forge, bob, open, { title: "Paint is peeling" });
    createLabel(forge, alice, open, "bug", "d73a4a");
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the dashboard lists your repositories and recent activity", async () => {
    const h = boot(forge, asAlice());
    await h.settle();
    const text = h.text();
    expect(text).toContain("alice/lighthouse");
    expect(text).toContain("alice/vault");
    expect(text).toContain("Recent activity");
    // English, not event kinds: nothing in the feed may read like a payload.
    expect(text).toContain("alice opened issue #1");
    expect(text).not.toMatch(/issue\.opened|repo\.created|label\.created/);
    // Account plumbing is not repo activity.
    expect(text).not.toContain("user.created");
    h.stop();
  });

  test("filter-as-you-type narrows the repository list", async () => {
    const h = boot(forge, asAlice());
    await h.settle();
    await h.press("/");
    await h.typeText("vault");
    // The repo pane is the left half; the activity feed on the right still
    // names lighthouse, so scope the assertion to the list being filtered.
    const list = h
      .text()
      .split("\n")
      .map((line) => line.slice(0, 70))
      .join("\n");
    expect(list).toContain("alice/vault");
    expect(list).not.toContain("alice/lighthouse");
    h.stop();
  });

  /**
   * A repository we made here has no origin, so its where-strip has two
   * places rather than three, no live banner, and every write key present.
   */
  test("a native repo says it is read from the workbench, and nowhere else", async () => {
    const h = boot(forge, asAlice());
    await h.settle();
    await openRepo(h, "lighthouse");
    const text = h.text();
    expect(text).toContain("● workbench");
    expect(text).toContain("○ this machine");
    expect(text).not.toContain("reading live from");
    expect(text).not.toContain("read-only");

    await h.press("?");
    const help = h.text();
    expect(help).toContain("settings");
    expect(help).toContain("fork");
    expect(help).not.toMatch(/m\s+mirror\b/);
    expect(help).not.toContain("open on origin");
    await h.press("esc");

    // Pinning is the third place arriving, and it is the same glyph the
    // dashboard uses.
    await h.press("P");
    await h.settle();
    expect(h.text()).toContain("◆ this machine");
    await h.press("P");
    await h.settle();
    expect(h.text()).toContain("○ this machine");
    h.stop();
  });

  test("the issue list shows seeded issues, filters, and counts", async () => {
    const h = boot(forge, asAlice());
    await h.settle();
    // By name, not by row: later tests add repositories, and a test that
    // depends on which one happened to be first breaks when they do.
    await openRepo(h, "lighthouse");
    await h.press("i");
    let text = h.text();
    expect(text).toContain("The lamp flickers");
    expect(text).toContain("Paint is peeling");
    expect(text).toContain("Open 2");

    await h.press("/");
    await h.typeText("lamp");
    expect(h.text()).toContain("The lamp flickers");
    expect(h.text()).not.toContain("Paint is peeling");
    h.stop();
  });

  test("commenting goes through the action, so the outbox sees it", async () => {
    const issue = getIssue(forge.db, open.id, 1);
    expect(issue).toBeDefined();
    const h = boot(forge, asAlice());
    await h.settle();
    await openIssueOne(h);

    await h.press("c");
    await h.typeText("Replaced the bulb.");
    await h.press("ctrl+d");

    const comments = listComments(forge.db, issue!.id);
    expect(comments.map((c) => c.body)).toContain("Replaced the bulb.");
    expect(
      listEvents(forge.db, { repoId: open.id }).map((e) => e.kind),
    ).toContain("issue.commented");
    expect(h.text()).toContain("Replaced the bulb.");
    h.stop();
  });

  test("close and reopen move the issue's state", async () => {
    const h = boot(forge, asAlice());
    await h.settle();
    await openIssueOne(h);
    await h.press("x");
    expect(getIssue(forge.db, open.id, 1)?.state).toBe("closed");
    expect(h.text()).toContain("closed");
    await h.press("o");
    expect(getIssue(forge.db, open.id, 1)?.state).toBe("open");
    h.stop();
  });

  test("the labels picker applies a label through setIssueLabels", async () => {
    const h = boot(forge, asAlice());
    await h.settle();
    await openIssueOne(h);
    await h.press("l");
    expect(h.text()).toContain("Labels");
    await h.press(" ", "enter");
    expect(h.text()).toContain("bug");
    expect(
      listEvents(forge.db, { repoId: open.id }).map((e) => e.kind),
    ).toContain("issue.labeled");
    h.stop();
  });

  test("the merge dialog merges a clean pull and refuses a conflicting one", async () => {
    const clean = await openPull(forge, alice, open, {
      title: "Add two",
      baseBranch: "main",
      headBranch: "feature",
    });
    const dirty = await openPull(forge, alice, open, {
      title: "Clash",
      baseBranch: "main",
      headBranch: "clash",
    });
    expect(clean.ok && dirty.ok).toBe(true);
    if (!clean.ok || !dirty.ok) return;

    const h = boot(forge, asAlice());
    await h.settle();
    await openRepo(h, "lighthouse");
    await h.press("p");
    // Newest first: the clash pull is on top, the clean one below it.
    await h.press("j", "enter");
    expect(h.text()).toContain("Add two");
    expect(h.text()).toContain("ready");
    await h.press("m");
    expect(h.text()).toContain("Merge #");
    await h.press("enter");
    await h.settle();
    expect(
      getPull(forge.db, open.id, clean.value.number)?.mergedAt,
    ).not.toBeNull();

    // The conflicting one cannot even open the dialog. Back to the list,
    // refresh it (the merged pull has left the open segment), open the top.
    await h.press("esc");
    await h.press("r");
    await h.press("g");
    await h.press("enter");
    expect(h.text()).toContain("Clash");
    expect(h.text()).toContain("conflicts");
    await h.press("m");
    expect(h.text()).not.toContain("Merge #");
    expect(getPull(forge.db, open.id, dirty.value.number)?.mergedAt).toBeNull();
    h.stop();
  });

  test("a guest sees no private repo, in a list or by name", async () => {
    const h = boot(forge, asGuest());
    await h.settle();
    expect(h.text()).toContain("alice/lighthouse");
    expect(h.text()).not.toContain("vault");

    // And not by name either: the palette's prompt reports not found.
    await h.press("ctrl+k");
    await h.typeText("Open a repository");
    await h.press("enter");
    await h.typeText("alice/vault");
    await h.press("enter");
    expect(h.text()).toContain("not found");
    h.stop();
  });

  test("signing in links the presenting key and unlocks the private repo", async () => {
    const h = boot(forge, asGuest());
    // The key this session presents becomes alice's on success, and the
    // fingerprint is unique across the forge — so it has to be handed back
    // however this test ends. It used to be released by a `DELETE FROM
    // user_key` on the last line, which a failing assertion above it skipped:
    // the *next* test to sign a guest in then failed with `key_exists`, and
    // the first failure was buried under a second one that made no sense.
    try {
      await h.settle();
      await h.press("s");
      expect(h.text()).toContain("Sign in");
      await h.typeText("alice");
      await h.press("tab");
      await h.typeText("a-long-passphrase");
      await h.press("enter");
      await h.settle();

      // The key is now alice's — asked about alice, not as a count of the
      // whole table, so another test's key can neither satisfy nor break it.
      const linked = forge.db
        .query<
          { n: number },
          [string]
        >("SELECT COUNT(*) AS n FROM user_key WHERE user_id = ?1")
        .get(alice.id);
      expect(linked!.n).toBe(1);
      await h.press("r");
      expect(h.text()).toContain("alice/vault");
    } finally {
      h.stop();
      forge.db.query("DELETE FROM user_key WHERE user_id = ?1").run(alice.id);
    }
  });

  test("a guest whose key is registered arrives as that user", async () => {
    const added = addSshKey(forge, bob, { name: "bob laptop", key: OTHER_KEY });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const h = boot(forge, {
      sshUsername: "git",
      remoteAddress: "127.0.0.1",
      fingerprint: added.value.fingerprint,
      keyId: added.value.id,
      user: bob,
    });
    try {
      await h.settle();
      expect(h.text()).toContain("bob");
      expect(h.text()).not.toContain("vault");
    } finally {
      h.stop();
      // Each test hands back exactly what it took, so nothing here depends
      // on the order the file happens to run in.
      forge.db.query("DELETE FROM user_key WHERE id = ?1").run(added.value.id);
    }
  });

  test("a repository's settings key hands over the web's one settings page, where deleting it lives", async () => {
    const doomed = await createRepo(forge, alice, { name: "doomed" });
    expect(doomed.ok).toBe(true);
    if (!doomed.ok) return;
    const h = boot(forge, asAlice());
    await h.settle();
    await openRepo(h, "doomed");
    await h.press(",");
    // #635: no settings screen in the terminal; the address, said as a path
    // when no public URL is configured, and nothing deleted on the way.
    await h.settle();
    expect(h.text()).toContain("Settings is on the web at /alice/doomed/settings");
    expect(getRepo(forge.db, "alice", "doomed")).toBeDefined();
    h.stop();
  });

  test("the theme is remembered for the next session", async () => {
    const h = boot(forge, asAlice());
    await h.settle();
    await h.press("ctrl+t", "j", "enter");
    const stored = getUserSetting(forge.db, alice.id, "theme");
    expect(stored).toBeDefined();
    h.stop();

    const again = boot(forge, asAlice());
    await again.settle();
    expect(again.text()).toContain(themeLabel(stored!));
    again.stop();
  });

  test("a screen that throws ends the session, not the process", async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on("unhandledRejection", onRejection);

    const session = fakeSshSession();
    let faults = 0;
    const app = new App({
      terminal: sshTerminal(session, () => {
        faults++;
        app.stop();
        session.exit(1);
      }),
      exitHooks: false,
      root: () => ({
        title: "Boom",
        keys: [],
        render: () => undefined,
        key: () => {
          throw new Error("a defect in a screen");
        },
      }),
    });
    app.start();
    session.emit("x");
    await new Promise((r) => setTimeout(r, 5));

    expect(faults).toBe(1);
    expect(session.exitCode).toBe(1);
    expect(rejections).toEqual([]);
    process.off("unhandledRejection", onRejection);
  });

  // --- helpers ---

  async function openRepo(h: Harness, name: string): Promise<void> {
    await h.press("/");
    await h.typeText(name);
    await h.press("enter"); // close the filter
    await h.press("enter"); // open the repo
  }

  async function openIssueOne(h: Harness): Promise<void> {
    await openRepo(h, "lighthouse");
    await h.press("i");
    // Issue #1 is the oldest, so it is last in a newest-first list.
    await h.press("G");
    await h.press("enter");
  }
});

describe("a forge with no accounts", () => {
  let dataDir = "";
  let forge: Forge;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-first-"));
    forge = createApp({ dataDir, port: 0 });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the first key through the door can create the admin account", async () => {
    const h = boot(forge, {
      sshUsername: "git",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:first",
      publicKey: KEY_LINE,
    });
    await h.settle();
    expect(h.text()).toContain("Guest");

    await h.press("s");
    expect(h.text()).toContain("no accounts yet");
    await h.typeText("founder");
    await h.press("tab");
    await h.typeText("founder@forge.test");
    await h.press("tab");
    await h.typeText("a-long-passphrase");
    await h.press("enter");
    await h.settle();

    const founder = getUserByName(forge.db, "founder");
    expect(founder?.isAdmin).toBe(true);
    // The key that created the account is registered to it, so the next
    // connection needs no password.
    const key = forge.db
      .query<{ user_id: string }, []>("SELECT user_id FROM user_key")
      .get();
    expect(key?.user_id).toBe(founder!.id);
    expect(h.text()).toContain("founder");
    h.stop();
  });
});

describe("git commands over an exec channel", () => {
  test("the shell quoting OpenSSH actually emits is understood", () => {
    expect(splitCommand("git-upload-pack '/a/b.git'")).toEqual([
      "git-upload-pack",
      "/a/b.git",
    ]);
    expect(splitCommand("git-upload-pack \\'weird")).toEqual([
      "git-upload-pack",
      "'weird",
    ]);
    expect(splitCommand("git-upload-pack 'unbalanced")).toBeNull();
  });

  test("both spellings resolve; decoration is stripped; guards apply", () => {
    expect(parseGitCommand("git-upload-pack '/alice/forge.git'")).toEqual({
      service: "git-upload-pack",
      owner: "alice",
      name: "forge",
    });
    expect(parseGitCommand("git upload-pack '~/alice/forge'")).toEqual({
      service: "git-upload-pack",
      owner: "alice",
      name: "forge",
    });
    expect(parseGitCommand("git-receive-pack 'alice/forge.git'")).toEqual({
      service: "git-receive-pack",
      owner: "alice",
      name: "forge",
    });
    // Traversal, flags, and anything that is not a git service are refused
    // before a path is ever joined.
    expect(parseGitCommand("git-upload-pack '../../etc/passwd'")).toBeNull();
    expect(parseGitCommand("git-upload-pack '-oProxyCommand=x/y'")).toBeNull();
    expect(parseGitCommand("rm -rf /")).toBeNull();
    expect(parseGitCommand("git-upload-pack 'a/b/c'")).toBeNull();
  });
});

/** The theme picker's label, for the persistence assertion. */
function themeLabel(name: string): string {
  const { THEMES } = require("../src/design/themes.ts") as {
    THEMES: Record<string, { label: string }>;
  };
  return THEMES[name]?.label ?? name;
}

/** An in-memory `SshSession`, so the adapter can be tested without a socket. */
function fakeSshSession(): SshSession & {
  emit(text: string): void;
  output(): string;
  exitCode: number | undefined;
} {
  let data: ((chunk: Uint8Array) => void) | undefined;
  let out = "";
  const session = {
    key: {
      algo: "ssh-ed25519",
      blob: new Uint8Array(),
      fingerprint: "SHA256:x",
      line: "ssh-ed25519 x",
    },
    username: "git",
    remoteAddress: "127.0.0.1",
    kind: "shell" as const,
    command: undefined,
    term: "xterm-256color",
    env: {},
    cols: 80,
    rows: 24,
    exitCode: undefined as number | undefined,
    write(bytes: Uint8Array | string) {
      out +=
        typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
    },
    writeStderr() {},
    onData(cb: (chunk: Uint8Array) => void) {
      data = cb;
    },
    onResize() {},
    onEof() {},
    onClose() {},
    ended: false,
    exit(code: number) {
      session.exitCode = code;
    },
    widthPx: 0,
    heightPx: 0,
    pending: 0,
    drain: () => Promise.resolve(),
    emit(text: string) {
      data?.(new TextEncoder().encode(text));
    },
    output: () => out,
  };
  return session;
}
