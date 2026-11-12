/**
 * Apps, runs and the crew, as the terminal still shows them (docs/APPS.md):
 * inside an issue, a pull and a repository's settings. The apps, app, runs,
 * run and crew screens are gone — the studio on the web is where an app is
 * run and a crew is managed — and the tests at the end prove no key or
 * palette entry still reaches for them.
 *
 * One real forge with a real `AppsRuntime`, driven headlessly. The app under
 * test is deliberately *not* an app — a README and nothing else — so every
 * deploy fails in milliseconds with the one sentence the runtime writes for
 * that, and the screens are asserted on the honest words they must carry:
 * "failed" beside its reason, never "failed" alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import type { Agent } from "../src/core/agents.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import {
  claimRun,
  createRun,
  finishRun,
  listRuns,
  type Run,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { appendRunLog } from "../src/runs/log.ts";
import type { App, Screen } from "../src/tui/app/app.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import type { Session, TuiIdentity } from "../src/tui/session.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const DOMAIN = "apps.test";
const NOT_AN_APP = "this commit is not an app";

interface Harness {
  app: App;
  session: Session;
  terminal: HeadlessTerminal;
  text(): string;
  rows(): string[];
  press(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  push(screen: (session: Session, ctx: App["ctx"]) => Screen): Promise<void>;
  settle(): Promise<void>;
  until(what: string, ms?: number): Promise<void>;
  /** Move the cursor down until the marked row names something. */
  select(name: string): Promise<void>;
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
  app.start();
  const settle = (): Promise<void> => settleApp(app);
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
  const grid = (): string[] => app.screen.toText().split("\n");
  const harness: Harness = {
    app,
    session,
    terminal,
    text: () => app.screen.toText(),
    rows: grid,
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
    async push(make) {
      app.ctx.push(make(session, app.ctx));
      await settle();
    },
    settle,
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
    async select(name) {
      await one("g");
      for (let i = 0; i < 30; i++) {
        if (grid().some((line) => line.includes(`▸ ${name}`))) return;
        await one("j");
      }
      throw new Error(`never selected ${name}:\n${app.screen.toText()}`);
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

describe("terminal: apps, runs and the crew", () => {
  let dataDir: string;
  let forge: Forge;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let robo: Agent;
  let site: Repo;
  let issue: Issue;
  let productionRun: Run;

  /** Wait for the newest run matching `where` to finish, and return it. */
  async function settled(
    where: (run: Run) => boolean,
    timeoutMs = 30_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(forge.db, site.id, { limit: 50 }).find(where);
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(50);
    }
    throw new Error("run did not settle in time");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-apps-"));
    forge = createApp({ dataDir, port: 0 });
    servers = await serve(forge);
    runtime = new AppsRuntime(forge, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();

    const a = await createUser(forge.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    await createUser(forge.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    const agent = await createAgent(forge, alice, {
      username: "robo",
      model: "sonnet",
      brief: "I write small, careful patches.",
    });
    if (!agent.ok) throw new Error(agent.error);
    robo = agent.value;

    // A repository that is not an app: its deploys fail fast and honestly.
    const made = await createRepo(forge, alice, {
      name: "site",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    site = made.value;
    const committed = await commitToBranch(forge, alice, site, {
      message: "first",
      files: [{ path: "README.md", content: "# site\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    site = getRepoById(forge.db, site.id) ?? site;
    const enabled = enableApp(forge, alice, site, {});
    if (!enabled.ok) throw new Error(enabled.error);
    const crewed = addToCrew(forge, alice, site, "robo");
    if (!crewed.ok) throw new Error(crewed.error);
    const opened = openIssue(forge, alice, site, {
      title: "Make the site sing",
      body: "A melody on the front page.",
    });
    if (!opened.ok) throw new Error(opened.error);
    issue = opened.value;
    productionRun = await settled((run) => run.env === "production");
    expect(productionRun.state).toBe("failed");
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("assign: nobody, the people who can read it, then the crew with its mark", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.push((s, ctx) =>
        issueScreen(s, ctx, local(s, site), issue.number),
      );
      await h.until("Make the site sing");
      await h.press("a");
      await h.until(`Assign #${issue.number}`);
      const text = h.text();
      expect(text).toContain("nobody");
      expect(text).toContain("alice");
      // bob has nothing to do with the repository, but it is public, so
      // bob can read it and is offered.
      expect(text).toContain("bob");
      expect(text).toContain("robo");
      expect(text).toContain("agent");
      await h.select("robo");
      await h.press("enter");
      await h.until("assigned to robo");
      expect(getIssue(forge.db, site.id, issue.number)?.assigneeId).toBe(
        robo.user.id,
      );
      // The head line names the assignee and says what it is.
      expect(h.text()).toContain("assigned to robo (agent)");

      // The crew's work on the issue is a card; `enter` from it hands over
      // the run's web page, where its log lives.
      const run = createRun(forge.db, {
        repoId: site.id,
        kind: "agent",
        issueId: issue.id,
        actorId: robo.user.id,
        reason: "assigned",
      });
      claimRun(forge.db, run.id);
      appendRunLog(dataDir, run.id, "cloning alice/site");
      finishRun(forge.db, run.id, {
        state: "ok",
        summary: "opened pull #2 with the melody",
        costUsd: 0.42,
      });
      await h.press("r");
      await h.until("Crew · 1 run");
      expect(h.text()).toContain("opened pull #2 with the melody");
      expect(h.text()).toContain("$0.42");
      await h.press("tab", "enter");
      await h.until("cloning alice/site");
      // The log screen's state line, not the web address.
      expect(h.text()).toContain("ok · agent · opened pull #2 with the melody · $0.42");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("assign on a private repository offers only those who can read it", async () => {
    const vault = await createRepo(forge, alice, {
      name: "vault",
      visibility: "private",
    });
    expect(vault.ok).toBe(true);
    if (!vault.ok) return;
    const secret = openIssue(forge, alice, vault.value, {
      title: "Keep the key",
      body: "",
    });
    expect(secret.ok).toBe(true);
    if (!secret.ok) return;

    const h = boot(forge, identityFor(alice));
    try {
      await h.push((s, ctx) =>
        issueScreen(s, ctx, local(s, vault.value), secret.value.number),
      );
      await h.until("Keep the key");
      await h.press("a");
      await h.until(`Assign #${secret.value.number}`);
      const text = h.text();
      expect(text).toContain("nobody");
      expect(text).toContain("alice");
      // bob exists, but cannot see the vault: the picker must not name bob,
      // and `assignIssue` would refuse it anyway (assignee_cannot_read).
      expect(text).not.toContain("bob");
      await h.press("esc");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("a pull: the preview line, the checks gate in words, O copies the link", async () => {
    const committed = await commitToBranch(forge, alice, site, {
      branch: "tune",
      base: site.defaultBranch,
      message: "Add a tune",
      files: [{ path: "TUNE.md", content: "la la la\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(forge, alice, site, {
      title: "Add a tune",
      baseBranch: site.defaultBranch,
      headBranch: "tune",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pull = opened.value;
    const preview = await settled((run) => run.env === `pull-${pull.number}`);
    expect(preview.state).toBe("failed");
    const gated = await updateRepoSettings(forge, alice, site, {
      requireChecks: true,
    });
    expect(gated.ok).toBe(true);

    const h = boot(forge, identityFor(alice));
    try {
      await h.push((s, ctx) => pullScreen(s, ctx, local(s, site), pull.number));
      await h.until("Add a tune");
      const text = h.text();
      // The preview, with its error; the checks, with theirs; the gate.
      expect(text).toContain(`preview failed: ${NOT_AN_APP}`);
      expect(text).toContain("checks: failed");
      expect(text).toContain("The deploy of this head failed");
      // `m` is refused in words, not silently.
      await h.press("m");
      expect(h.text()).toContain("the deploy of this head failed");
      // `O` cannot open a browser from a headless session: the URL goes to
      // the clipboard through OSC 52 and the toast names the gesture.
      h.terminal.takeOutput();
      await h.press("O");
      expect(h.terminal.takeOutput()).toContain("]52;c;");
      // …and the link dialog shows it plain, with the mouse released so it
      // can be selected by hand; esc puts things back.
      expect(h.text()).toContain("Link");
      expect(h.text()).toContain("http://site--2.apps.test");
      expect(h.text()).toContain("Select the address");
      h.terminal.takeOutput();
      await h.press("esc");
      expect(h.text()).not.toContain("Select the address");
      expect(h.terminal.takeOutput()).toContain("?1000h");
      // `a` offers the same picker a pull gets.
      await h.press("a");
      await h.until(`Assign #${pull.number}`);
      await h.press("esc");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("the dashboard: an On you pane, enterable, and no Apps pane", async () => {
    const mine = openIssue(forge, alice, site, {
      title: "Tune the drums",
      body: "",
    });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const assigned = assignIssue(forge, alice, site, mine.value, alice);
    expect(assigned.ok).toBe(true);

    const h = boot(forge, identityFor(alice));
    try {
      await h.until("On you");
      expect(h.text()).toContain("Tune the drums");
      // The word the web's asks row shows, and on whom (#1825).
      expect(h.text()).toContain("assigned to you · on you");
      expect(h.text()).not.toContain("Apps");
      // repos → on you.
      await h.press("tab", "enter");
      await h.until("assigned to alice");
      expect(h.text()).toContain("Tune the drums");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("finding someone else's repository is the launcher's filter: yours by default, anything you can see once you type", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const theirs = await createRepo(forge, alice, {
      name: "alices-lantern",
      visibility: "public",
    });
    expect(theirs.ok).toBe(true);
    const hidden = await createRepo(forge, alice, {
      name: "alices-diary",
      visibility: "private",
    });
    expect(hidden.ok).toBe(true);
    const h = boot(forge, identityFor(bob));
    try {
      await h.until("On you");
      expect(h.text()).not.toContain("alice/alices-lantern");
      await h.press("/");
      await h.type("alices");
      await h.until("alice/alices-lantern");
      // A private repository bob cannot read never shows, typed or not.
      expect(h.text()).not.toContain("alices-diary");
      await h.press("enter", "enter");
      await h.until("alice/alices-lantern");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("a typed filter finds a repository past the newest 200 the launcher read first (#1068)", async () => {
    // Rows alone: the launcher reads the table, and 250 bare repositories
    // would take minutes to init. Ids sort newest first, so the lantern is oldest.
    const insert = forge.db.query(
      "INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)",
    );
    insert.run("zz1068-000", alice.id, "faraway-lantern", "public");
    insert.run("zz1068-001", alice.id, "faraway-secret", "private");
    for (let i = 2; i <= 250; i++)
      insert.run(`zz1068-${String(i).padStart(3, "0")}`, alice.id, `filler-${i}`, "public");
    const bob = getUserByName(forge.db, "bob")!;
    const h = boot(forge, identityFor(bob));
    try {
      await h.until("On you");
      await h.press("/");
      await h.type("faraway");
      await h.until("alice/faraway-lantern");
      // Past the first page, visibility still holds.
      expect(h.text()).not.toContain("faraway-secret");
      await h.press("esc");
      await h.press("/");
      await h.type("alice/faraway-l");
      await h.until("alice/faraway-lantern");
    } finally {
      h.stop();
      forge.db.run("DELETE FROM repo WHERE id LIKE 'zz1068-%'");
    }
  }, 30_000);

  test("the removed screens are unreachable: no palette entry, no dashboard or account key", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.until("On you");
      // alice is the site admin, so the crew entry would have been there.
      const ids = forgeCommands(h.session)(h.app.ctx).map((c) => c.id);
      for (const gone of ["apps", "app", "runs", "crew"])
        expect(ids).not.toContain(gone);
      expect(ids).toContain("repo");
      expect(ids).toContain("pulls");

      const before = h.text();
      expect(before).not.toContain("new app");
      for (const key of ["a", "N", "t"]) {
        await h.press(key);
        expect(h.text()).toBe(before);
      }

      // The account key hands over the web's settings page (#635).
      await h.press("A");
      await h.until("Account settings is on the web at /settings");

      // What stays first-class is one key away: the workspace opens on the
      // repository, its tree and its README.
      await h.select("alice/site");
      await h.press("enter");
      await h.until("README.md");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("a non-admin's account key hands over the same web page", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const h = boot(forge, identityFor(bob));
    try {
      await h.press("A");
      await h.until("Account settings is on the web at /settings");
    } finally {
      h.stop();
    }
  }, 30_000);
});
