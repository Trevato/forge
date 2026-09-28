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
 * Two halves, because they need two worlds.
 *
 * - **At an origin** — a fake Forgejo API in front of a *second real forge*
 *   that is the git host behind its clone URLs. That is the only way to test
 *   forking and proposing honestly: the fork is a real repository, the push
 *   really leaves the machine, and the pull is opened on the upstream with
 *   the `owner:branch` head form both forges take.
 * - **At home** — one forge, an org with two writers, and one pull. Verdicts,
 *   the merge gate, and thread resolution are all about *who said what about
 *   which head*, and nothing about that needs another machine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOrigin, resetConnectLimit } from "../src/actions/origins.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { listReviews } from "../src/core/reviews.ts";
import { getPull } from "../src/core/pulls.ts";
import type { User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import type { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";

quietLogs();

interface Harness {
  app: App;
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
  const { app } = createForgeApp(forge, identity, {
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

describe("workflows at an origin", () => {
  let dataDir: string;
  let originDataDir: string;
  let forge: Forge;
  let originApp: Forge;
  let originServers: Servers;
  let fake: FakeForge;
  let alice: User;
  let originToken = "";

  const ORIGIN_LOGIN = "me";
  const UPSTREAM = "octo";
  const PASSWORD = "workflow-account-passphrase";

  const basic = (user: string): string =>
    `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}`;

  const upstream = (
    path: string,
    init: RequestInit & { as?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic(init.as ?? UPSTREAM));
    return fetch(`${originServers.url}${path}`, { ...init, headers });
  };

  async function mkAccount(username: string): Promise<string> {
    await fetch(`${originServers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@upstream.test`,
        password: PASSWORD,
      }),
    });
    const made = (await (
      await fetch(`${originServers.url}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          password: PASSWORD,
          name: "t",
          scope: "admin",
        }),
      })
    ).json()) as { token: string };
    return made.token;
  }

  async function seed(name: string, owner = UPSTREAM): Promise<void> {
    await upstream("/api/v1/repos", {
      as: owner,
      method: "POST",
      body: JSON.stringify({ name, visibility: "public" }),
    });
    await upstream(`/api/v1/repos/${owner}/${name}/contents`, {
      as: owner,
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [
          { path: "README.md", content: `# ${name}\n\nread live\n` },
          { path: "a.txt", content: "one\n" },
        ],
      }),
    });
  }

  /** Dashboard → account → origins → browse this origin's repositories. */
  const openPicker = async (h: Harness): Promise<void> => {
    await h.press("A");
    await h.until("Account");
    await h.press("o");
    await h.until("Origins");
    await h.press("r");
    await h.until(`${UPSTREAM}/gears`);
  };

  /**
   * Put the picker's cursor on a named row. `row()` marks the selected one
   * with `▸`, so this asserts on what the reader would look at rather than on
   * an index that shifts the moment the listing is sorted differently.
   */
  const select = async (h: Harness, name: string): Promise<void> => {
    await h.press("g");
    for (let i = 0; i < 20; i++) {
      if (h.rows().some((line) => line.includes(`▸ ${name} `))) return;
      await h.press("j");
    }
    throw new Error(`never selected ${name}:\n${h.text()}`);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tuiwf-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-tuiwf-up-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await mkAccount(UPSTREAM);
    originToken = await mkAccount(ORIGIN_LOGIN);
    await seed("gears");
    await seed("widgets");
    await seed("own", ORIGIN_LOGIN);

    // `me` really forks both upstreams on the *git host*, so the clone URL
    // the fake hands back for a fork points at a repository that exists and
    // that `me` may push to. The fake's own state deliberately does not know
    // about them, so the TUI's `F` really does POST /forks and really does
    // poll for the repository the origin promised.
    for (const name of ["gears", "widgets"]) {
      const forked = await upstream(`/api/v1/repos/${UPSTREAM}/${name}/forks`, {
        as: ORIGIN_LOGIN,
        method: "POST",
        body: "{}",
      });
      expect(forked.status).toBe(201);
    }

    const git = (name: string, owner = UPSTREAM): string =>
      `${originServers.url}/${owner}/${name}.git`;
    const state = newFakeState("forgejo", ORIGIN_LOGIN, originToken);
    state.repos.push(
      {
        id: 1,
        fullName: `${UPSTREAM}/gears`,
        description: "cannot push here",
        cloneUrl: git("gears"),
        htmlUrl: `${originServers.url}/${UPSTREAM}/gears`,
        defaultBranch: "main",
        push: false,
        admin: false,
      },
      {
        id: 2,
        fullName: `${UPSTREAM}/widgets`,
        description: "cannot push here either",
        cloneUrl: git("widgets"),
        htmlUrl: `${originServers.url}/${UPSTREAM}/widgets`,
        defaultBranch: "main",
        push: false,
        admin: false,
      },
      {
        id: 3,
        fullName: `${ORIGIN_LOGIN}/own`,
        description: "mine, and I may push",
        cloneUrl: git("own", ORIGIN_LOGIN),
        htmlUrl: `${originServers.url}/${ORIGIN_LOGIN}/own`,
        defaultBranch: "main",
        push: true,
        admin: true,
      },
    );
    // The origin does not finish making a fork before it answers.
    state.forkDelayReads = 1;
    for (const name of [
      `${UPSTREAM}/gears`,
      `${UPSTREAM}/widgets`,
      `${ORIGIN_LOGIN}/own`,
    ]) {
      state.branches.set(name, [
        { name: "main", sha: "1".repeat(40), protected: false },
      ]);
      state.files.set(
        name,
        new Map([
          ["README.md", `# ${name.split("/")[1]}\n\nread live\n`],
          ["a.txt", "one\n"],
        ]),
      );
    }
    fake = serveFakeForge(state);

    forge = createApp({ dataDir, port: 0 });
    const created = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!created.ok) throw new Error("signup failed");
    alice = created.value;
    resetConnectLimit();
    forgetProviders(dataDir);

    const connected = await connectOrigin(forge, alice, {
      host: fake.url,
      token: originToken,
    });
    if (!connected.ok)
      throw new Error(`connect failed: ${String(connected.error)}`);
  }, 120_000);

  afterAll(async () => {
    fake.stop();
    originServers.stop();
    forge.close();
    originApp.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  }, 60_000);

  test("F on a live browse forks at the origin and lands in the fork", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await openPicker(h);
      await select(h, `${UPSTREAM}/gears`);
      // Opened with the pointer: a click selects, a second click opens —
      // the picker's rows answer the mouse like every other list.
      const row = h.rowOf(`${UPSTREAM}/gears`);
      expect(row).toBeGreaterThan(0);
      await h.click(4, row, 2);
      await h.until("read live");
      expect(h.text()).toContain("reading live from");

      await h.press("F");
      // The card says the whole sentence: two machines are involved.
      await h.until(`Fork ${UPSTREAM}/gears to your account`);
      expect(h.text()).toContain("and mirror it here?");

      await h.press("enter");
      // The mirror runs over the job the fork started; wait for the
      // outcome — the fork's own workspace — rather than the mirror card,
      // which can finish and be gone before the next poll ever sees it.
      await h.until(`fork of ${UPSTREAM}/gears`, 60_000);
      // The card was still shown: the harness saw it pushed.
      expect(h.opened().some((t) => t.startsWith("Mirroring"))).toBe(true);

      const fork = getRepo(forge.db, "alice", "gears");
      expect(fork).toBeDefined();
      // The about card says it too, in words, beside the clone URLs.
      await h.press("I");
      await h.until("About");
      expect(h.text()).toContain(`fork of ${UPSTREAM}/gears`);
      await h.press("esc");

      const posts = fake.state.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/gears/forks"),
      );
      expect(posts).toHaveLength(1);
    } finally {
      h.stop();
    }
  }, 120_000);

  test("a change on an unpushable upstream becomes a pull on it", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await openPicker(h);
      // Take a copy of `octo/widgets` first, so the pull that comes back has
      // somewhere here to be imported into — the "local import" half.
      await select(h, `${UPSTREAM}/widgets`);
      await h.press("m");
      // Wait for the outcome, not the mirror card: on a fast machine the
      // job can finish before the next poll ever sees "Mirroring".
      await h.until("mirrored as alice/widgets", 60_000);
      expect(getRepo(forge.db, "alice", "widgets")).toBeDefined();
      expect(h.opened()).toContain(`Mirroring ${UPSTREAM}/widgets`);

      // Now browse it live: read-only, and not ours to push to.
      await h.press("enter");
      await h.until("read live");
      expect(h.text()).toContain(`proposing to ${UPSTREAM}/widgets`);

      // Edit the README and propose it.
      await h.press("e");
      await h.settle();
      await h.type("hello from alice");
      await h.press("esc");
      await h.press("c");
      await h.until("Propose a change");
      const dialog = h.text();
      // The proposal dialog, not the commit dialog.
      expect(dialog).not.toContain("commit to main");
      expect(dialog).toContain("Branch in your fork");
      expect(dialog).toContain(`Pull request`);
      expect(dialog).toContain(`${UPSTREAM}/widgets`);

      await h.press("ctrl+s");
      await h.until(`opened pull #1 on ${UPSTREAM}/widgets`, 90_000);

      // The head form both forges take, with the fork's owner on the front.
      const opened = fake.state.requests.find(
        (r) => r.method === "POST" && r.path.endsWith("/widgets/pulls"),
      );
      expect(opened).toBeDefined();
      const body = JSON.parse(opened!.body) as { head: string; base: string };
      expect(body.head).toContain(":");
      expect(body.head.split(":")[0]).toBe(ORIGIN_LOGIN);
      expect(body.head.split(":").at(-1)).toContain("edit-");
      expect(body.base).toBe("main");

      // The branch really landed in the fork's git — asked of the git host
      // itself, not of anything this forge remembers about it.
      const branch = body.head.split(":").at(-1)!;
      const branches = (await (
        await upstream(`/api/v1/repos/${ORIGIN_LOGIN}/widgets/branches`, {
          as: ORIGIN_LOGIN,
        })
      ).json()) as { name: string }[];
      expect(branches.map((b) => b.name)).toContain(branch);

      // And the pull was imported into our mirror of the upstream, so the
      // screen could follow the reader straight to it.
      await h.until("Merge", 30_000);
      expect(h.text()).toContain("#1");
      expect(h.text()).toContain("Conversation");
    } finally {
      h.stop();
    }
  }, 180_000);

  test("a repository you may push to keeps the ordinary commit dialog", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.settle();
      await openPicker(h);
      await select(h, `${ORIGIN_LOGIN}/own`);
      // Mirror it, then work on the copy: this is the push-capable path.
      // Wait for the outcome, not the mirror card — see the fork test above.
      await h.press("m");
      await h.until("mirrored as alice/own", 60_000);
      expect(h.opened()).toContain(`Mirroring ${ORIGIN_LOGIN}/own`);
      await h.press("enter");
      await h.until("read live");
      // The origin says this one is ours to push to, so nothing is proposed.
      expect(h.text()).not.toContain("proposing to");

      // On the copy we hold, the ordinary dialog: a ref to commit onto.
      await h.press("W");
      await h.until("workbench");
      await h.press("e");
      await h.settle();
      await h.type("x");
      await h.press("esc");
      await h.press("c");
      await h.until("commit to main");
      expect(h.text()).not.toContain("Propose a change");
      await h.press("esc");
    } finally {
      h.stop();
    }
  }, 180_000);
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
    const one = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    const two = await signUp(forge, {
      username: "bob",
      email: "bob@forge.test",
      password: "another-long-passphrase",
    });
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
      // Turn the gate on through the settings screen the feature added.
      await admin.until("acme/lighthouse");
      await admin.press("enter");
      await admin.until("README");
      await admin.press(",");
      await admin.until("require review");
      expect(admin.text()).toContain("off");
      await admin.press("R");
      await admin.until("on — a pull needs an approval");
      await admin.press("esc");

      await admin.press("p");
      await admin.until("Tweak the lamp");
      await admin.press("enter");
      await admin.until("#1");
      // The box says what is missing, and `m` says it out loud.
      expect(admin.text()).toContain("review");
      await admin.press("m");
      expect(admin.text()).toContain("approval");
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
      await reviewer.until("1 approval", 30_000);

      // The list wears the same verdict, in one tabular column.
      await reviewer.press("q");
      await reviewer.until("Tweak the lamp", 30_000);
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

      // The owner screen's repository list, which had no pointer at all: a
      // click selects, a second click on the same row opens — the file
      // manager gesture every other list in the terminal already answers.
      await h.press("q");
      await h.until("Recent activity", 30_000);
      await h.press("tab", "tab", "tab");
      await h.until("Organizations");
      await h.press("enter");
      await h.until("lighthouse", 30_000);
      const repoRow = h.rowOf("lighthouse", 40);
      expect(repoRow).toBeGreaterThan(0);
      await h.click(4, repoRow);
      await h.click(4, repoRow);
      await h.until("acme/lighthouse", 30_000);
      expect(h.text()).toContain("README");
    } finally {
      h.stop();
    }
  }, 60_000);
});
