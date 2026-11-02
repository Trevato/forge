/**
 * The workflows, end to end, through the terminal.
 *
 * A unit test can prove `contribute` opens a pull. What it cannot prove is
 * that a person sitting in a repository they cannot push to is *told* so,
 * offered the right dialog, and left holding a link to what they proposed —
 * which is the whole of the feature. So everything here drives the real loop
 * against a real forge and asserts against the cell grid the renderer
 * produced, with no sleeps: every wait is `settleApp`.
 *
 * One forge, an org with two writers, and one pull. Verdicts, the merge
 * gate, and thread resolution are all about *who said what about which
 * head*, and nothing about that needs another machine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { getIssue, listComments } from "../src/core/issues.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { local } from "../src/tui/screens/where.ts";
import { listReviews } from "../src/core/reviews.ts";
import { getPull } from "../src/core/pulls.ts";
import type { User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import type { App, Screen } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { Session, TuiIdentity } from "../src/tui/session.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

interface Harness {
  app: App;
  push(screen: (session: Session, ctx: App["ctx"]) => Screen): Promise<void>;
  terminal: HeadlessTerminal;
  text(): string;
  rows(): string[];
  rowOf(what: string, within?: number): number;
  press(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  click(col: number, row: number, times?: number): Promise<void>;
  settle(): Promise<void>;
  /** Pump until the screen says something, or give up loudly. */
  until(what: string, ms?: number): Promise<void>;
  /**
   * The title of every screen pushed since boot, in order. A card that
   * comes down the moment its work is done — the mirror card over a small
   * repository — can be up and gone between two looks at the screen; this
   * is how a test says it was shown without racing it.
   */
  opened(): string[];
  /** Press one key until the screen says something — for walking a viewport. */
  walk(key: string, what: string, limit?: number): Promise<void>;
  stop(): void;
}

function boot(
  forge: Forge,
  identity: TuiIdentity,
  cols = 140,
  rows = 44,
): Harness {
  const terminal = headlessTerminal(cols, rows);
  const { app, session } = createForgeApp(forge, identity, {
    terminal,
    exitHooks: false,
  });
  const opened: string[] = [];
  const push = app.push.bind(app);
  app.push = (screen) => {
    opened.push(screen.title);
    push(screen);
  };
  app.start();
  const settle = (): Promise<void> => settleApp(app);
  const grid = (): string[] => app.screen.toText().split("\n");
  const one = async (key: string): Promise<void> => {
    const ctrl = key.startsWith("ctrl+");
    const shift = key.startsWith("shift+");
    app.dispatch({
      type: "key",
      key: ctrl ? key.slice(5) : shift ? key.slice(6) : key,
      ctrl,
      alt: false,
      shift,
    });
    await settle();
  };
  const harness: Harness = {
    app,
    async push(make) {
      app.ctx.push(make(session, app.ctx));
      await settle();
    },
    terminal,
    text: () => app.screen.toText(),
    rows: grid,
    rowOf: (what, within) =>
      grid().findIndex((line) =>
        (within === undefined ? line : line.slice(0, within)).includes(what),
      ),
    async press(...keys) {
      for (const key of keys) await one(key);
    },
    async type(text) {
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
    async click(col, row, times = 1) {
      for (let i = 0; i < times; i++) {
        terminal.feed(`\x1b[<0;${col + 1};${row + 1}M`);
        terminal.feed(`\x1b[<0;${col + 1};${row + 1}m`);
      }
      await settle();
    },
    settle,
    opened: () => [...opened],
    async until(what, ms = 30_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        await settle();
        if (app.screen.toText().includes(what)) return;
        if (Date.now() > deadline)
          throw new Error(
            `never saw ${JSON.stringify(what)} on screen:\n${app.screen.toText()}`,
          );
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async walk(key, what, limit = 40) {
      for (let i = 0; i < limit; i++) {
        if (app.screen.toText().includes(what)) return;
        await one(key);
      }
      if (!app.screen.toText().includes(what))
        throw new Error(
          `${key} never reached ${JSON.stringify(what)}:\n${app.screen.toText()}`,
        );
    },
    stop: () => app.stop(),
  };
  return harness;
}

const identityFor = (user: User): TuiIdentity => ({
  sshUsername: user.username,
  remoteAddress: "127.0.0.1",
  fingerprint: `SHA256:${user.username}`,
  user,
});

// ---------------------------------------------------------------------------

describe("reviews, threads and the merge gate", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;
  let repo: Repo;

  /** Repo → pulls → the one pull. */
  const openThePull = async (h: Harness): Promise<void> => {
    await h.until("acme/lighthouse");
    await h.press("enter");
    await h.until("README");
    await h.press("p");
    await h.until("Tweak the lamp");
    await h.press("enter");
    await h.until("#1");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tuirev-"));
    forge = createApp({ dataDir, port: 0 });
    const one = await seedAdmin(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    const two = await signUp(
      forge,
      {
        username: "bob",
        email: "bob@forge.test",
        password: "another-long-passphrase",
      },
      { slot: fixtureSlot(forge) },
    );
    if (!one.ok || !two.ok) throw new Error("signup failed");
    alice = one.value;
    bob = two.value;

    // An org, because write access to somebody else's pull is a team thing:
    // a personal repo has exactly one writer, and a review gate needs two.
    const org = createOrg(forge, alice, "acme");
    if (!org.ok) throw new Error("org failed");
    const team = createTeam(forge, alice, org.value, "Writers", "write");
    if (!team.ok) throw new Error("team failed");
    addTeamMember(forge, alice, org.value, team.value, "alice");
    addTeamMember(forge, alice, org.value, team.value, "bob");

    const made = await createRepo(forge, alice, {
      owner: "acme",
      name: "lighthouse",
      visibility: "public",
    });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
    await commitToBranch(forge, alice, repo, {
      message: "seed",
      files: [
        { path: "README.md", content: "# Lighthouse\n\nthe lamp\n" },
        { path: "src/lamp.ts", content: "export const lamp = 1;\n" },
      ],
    });
    await commitToBranch(forge, alice, repo, {
      branch: "fix",
      base: "main",
      message: "brighten the lamp",
      files: [{ path: "src/lamp.ts", content: "export const lamp = 2;\n" }],
    });
    const pull = await openPull(forge, alice, repo, {
      title: "Tweak the lamp",
      baseBranch: "main",
      headBranch: "fix",
    });
    if (!pull.ok) throw new Error("pull failed");
  }, 60_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the author is not offered the option to approve their own change", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await openThePull(h);
      await h.press("R");
      await h.until("Review #1");
      const card = h.text();
      expect(card).toContain("request changes");
      expect(card).toContain("comment");
      // Absent, not disabled: the server refuses it too (`self_review`).
      expect(card).not.toContain("approve");
      await h.press("esc");
    } finally {
      h.stop();
    }
  }, 60_000);

  test("a verdict renders with its state, and a push dismisses it", async () => {
    const h = boot(forge, identityFor(bob));
    try {
      await h.settle();
      await openThePull(h);
      await h.press("R");
      await h.until("Review #1");
      // Bob is not the author, so approving is on offer and is the default.
      expect(h.text()).toContain("approve");
      await h.press("ctrl+d");
      await h.until("approved");

      // The conversation carries it as a timeline item with a state chip.
      expect(h.text()).toContain("bob");
      // The merge box counts it.
      expect(h.text()).toContain("1 approval");

      // A push is new code nobody has looked at.
      await commitToBranch(forge, alice, repo, {
        branch: "fix",
        message: "one more",
        files: [{ path: "src/lamp.ts", content: "export const lamp = 3;\n" }],
      });
      await h.press("r");
      await h.until("before the latest push", 30_000);
      expect(h.text()).not.toContain("1 approval");

      const reviews = listReviews(forge.db, getPull(forge.db, repo.id, 1)!.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.state).toBe("approved");
    } finally {
      h.stop();
    }
  }, 60_000);

  test("require-review refuses the merge until the head is approved", async () => {
    const admin = boot(forge, identityFor(alice));
    try {
      await admin.settle();
      // Turn the gate on: settings are the web's one page now (#635), so
      // this goes through the same action that page posts to.
      const on = await updateRepoSettings(forge, alice, repo, {
        requireReview: true,
      });
      expect(on.ok).toBe(true);
      await admin.until("acme/lighthouse");
      await admin.press("enter");
      await admin.until("README");

      await admin.press("p");
      await admin.until("Tweak the lamp");
      await admin.press("enter");
      await admin.until("#1");
      // The footer wears "review" from the first paint, before the setting
      // has loaded; settle() waits for the pull's own load, so the gate's
      // line is read once, not polled for.
      await admin.settle();
      expect(admin.text()).toContain("Needs an approval of this head");
      // `m` while it is unread is a no-op, never a merge; loaded, it speaks.
      await admin.press("m");
      expect(admin.text()).toContain("needs an approval of its current head first");
      expect(getPull(forge.db, repo.id, 1)?.mergedAt).toBeNull();
    } finally {
      admin.stop();
    }

    // Bob approves the head that is actually there now.
    const reviewer = boot(forge, identityFor(bob));
    try {
      await reviewer.settle();
      await openThePull(reviewer);
      await reviewer.press("R");
      await reviewer.until("Review #1");
      await reviewer.press("ctrl+d");
      await reviewer.settle();
      expect(reviewer.text()).toContain("1 approval");

      // The list wears the same verdict, in one tabular column.
      await reviewer.press("q");
      // The title paints before the verdict column loads: settle waits for it.
      await reviewer.settle();
      expect(reviewer.text()).toContain("Tweak the lamp");
      expect(reviewer.text()).toContain("✓");
    } finally {
      reviewer.stop();
    }

    const merger = boot(forge, identityFor(alice));
    try {
      await merger.settle();
      await openThePull(merger);
      await merger.until("Ready to merge", 30_000);
      await merger.press("m");
      await merger.until("Merge #1");
      await merger.press("enter");
      await merger.until("merged as", 30_000);
      expect(getPull(forge.db, repo.id, 1)?.mergedAt).not.toBeNull();
    } finally {
      merger.stop();
    }
  }, 120_000);

  test("a review thread resolves, collapses, and reopens", async () => {
    // A second pull, so the merged one above is out of the way.
    await commitToBranch(forge, alice, repo, {
      branch: "second",
      base: "main",
      message: "another change",
      files: [{ path: "src/lamp.ts", content: "export const lamp = 9;\n" }],
    });
    const pull = await openPull(forge, alice, repo, {
      title: "A second change",
      baseBranch: "main",
      headBranch: "second",
    });
    expect(pull.ok).toBe(true);

    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await h.until("acme/lighthouse");
      await h.press("enter");
      await h.until("README");
      await h.press("p");
      await h.until("A second change");
      await h.press("enter");
      await h.until("#2");

      // Anchor a review comment on a diff line.
      await h.press("tab");
      await h.settle();
      await h.press("n"); // onto the first hunk
      await h.press("j");
      await h.press("c");
      await h.until("Review src/lamp.ts");
      await h.type("this needs a comment");
      await h.press("ctrl+d");
      await h.until("1 thread · 1 unresolved", 30_000);

      // Walk the viewport into the thread, then settle it.
      await h.walk("j", "this needs a comment");
      await h.press("x");
      await h.until("1 thread · 0 unresolved", 30_000);
      expect(h.text()).toContain("resolved by alice");
      expect(h.text()).toContain("enter to expand");
      // Collapsed: the comment itself is gone from the diff.
      expect(h.text()).not.toContain("this needs a comment");

      // Enter opens the record back up without reopening the conversation.
      await h.walk("j", "enter to expand");
      await h.press("enter");
      await h.settle();
      expect(h.text()).toContain("this needs a comment");
      expect(h.text()).toContain("1 thread · 0 unresolved");

      // `x` is the one that reopens it.
      await h.press("x");
      await h.until("1 thread · 1 unresolved", 30_000);
    } finally {
      h.stop();
    }
  }, 120_000);

  test("ctrl+t opens the appearance picker inside a workspace", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await h.until("acme/lighthouse");
      await h.press("enter");
      await h.until("README");

      // `t` belongs to the workspace: it is the file finder.
      await h.press("t");
      await h.settle();
      expect(h.text()).not.toContain("Appearance");
      await h.press("esc");
      await h.settle();

      // …and the appearance picker is one key everywhere.
      await h.press("ctrl+t");
      await h.settle();
      expect(h.text()).toContain("Appearance");
      expect(h.text()).toContain("Images");
      expect(h.text()).toContain("Icons");
      await h.press("esc");
      await h.settle();
      expect(h.text()).not.toContain("Images");
    } finally {
      h.stop();
    }
  }, 60_000);

  test("the newly wired lists answer the pointer", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await h.until("acme/lighthouse");
      await h.press("enter");
      await h.until("README");

      // The ref picker: click a row, then click it again to pick it.
      await h.press("b");
      await h.until("main");
      const row = h.rowOf("fix", 40);
      expect(row).toBeGreaterThan(0);
      await h.click(4, row);
      await h.click(4, row);
      await h.until("fix", 30_000);
    } finally {
      h.stop();
    }
  }, 60_000);

  test("an issue the crew found done on main says so, and x closes it with the note", async () => {
    // The crew's word is the one from whoever set autonomy going.
    forge.db.run("UPDATE repo SET autonomy_by = ?1 WHERE id = ?2", [
      alice.id,
      repo.id,
    ]);
    const opened = openIssue(forge, alice, repo, {
      title: "Already built",
      body: "It exists.",
    });
    if (!opened.ok) throw new Error(opened.error);
    const note = addComment(
      forge,
      alice,
      repo,
      opened.value,
      `Done on main already, waiting for you to close it: [\`${"a".repeat(40)}\`]`,
    );
    expect(note.ok).toBe(true);
    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await h.push((s, ctx) =>
        issueScreen(s, ctx, local(s, repo), opened.value.number),
      );
      await h.until("done on main in aaaaaaa, x to close");
      await h.press("x");
      await h.until("closed");
      expect(getIssue(forge.db, repo.id, opened.value.number)?.state).toBe(
        "closed",
      );
      expect(
        listComments(forge.db, opened.value.id).some((c) =>
          c.body.startsWith("Closed: already done on main in "),
        ),
      ).toBe(true);
      expect(h.text()).not.toContain("x to close");
    } finally {
      h.stop();
    }
  });
  test("p on a sealed issue shows the private repository and its clone URL, with the same refusals", async () => {
    const sealed = openIssue(forge, alice, repo, {
      title: "Token leak",
      sealed: true,
    });
    const plain = openIssue(forge, alice, repo, { title: "A typo" });
    if (!sealed.ok || !plain.ok) throw new Error("issues");
    const open = (user: User) => boot(forge, identityFor(user));

    const h = open(alice);
    try {
      await h.settle();
      await h.push((s, ctx) =>
        issueScreen(s, ctx, local(s, repo), sealed.value.number),
      );
      await h.until("private repo");
      await h.press("p");
      await h.until("private repository alice/");
      expect(h.text()).toContain("-sealed.git");
      expect(h.text()).toContain("http://localhost");
    } finally {
      h.stop();
    }

    // An issue that is not sealed has nothing to hide, and no key for it.
    const g = open(alice);
    try {
      await g.settle();
      await g.push((s, ctx) =>
        issueScreen(s, ctx, local(s, repo), plain.value.number),
      );
      await g.until("A typo");
      expect(g.text()).not.toContain("private repo");
      await g.press("p");
      expect(g.text()).not.toContain("private repository alice/");
    } finally {
      g.stop();
    }

    // A writer whose email is not verified is refused.
    const b = open(bob);
    try {
      await b.settle();
      await b.push((s, ctx) =>
        issueScreen(s, ctx, local(s, repo), sealed.value.number),
      );
      await b.until("Token leak");
      await b.press("p");
      await b.until("Verify your email first");
    } finally {
      b.stop();
    }
  }, 60_000);
});
