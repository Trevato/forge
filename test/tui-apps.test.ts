/**
 * Apps, runs and the crew, through the terminal (docs/APPS.md).
 *
 * One real forge with a real `AppsRuntime`, driven headlessly. The app under
 * test is deliberately *not* an app — a README and nothing else — so every
 * deploy fails in milliseconds with the one sentence the runtime writes for
 * that, and the screens are asserted on the honest words they must carry:
 * "failed" beside its reason, never "failed" alone. The live half is real
 * too: a line appended to a run's log lands on the run screen through the
 * in-process listener, and an event on the bus redraws the app.
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
import { getAgentByName, type Agent } from "../src/core/agents.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getIssue, listIssues, type Issue } from "../src/core/issues.ts";
import { getRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import {
  claimRun,
  createRun,
  finishRun,
  listRuns,
  type Run,
} from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { appendRunLog } from "../src/runs/log.ts";
import type { App, Screen } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { runsScreen } from "../src/tui/screens/runs.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { settingsScreen } from "../src/tui/screens/settings.ts";
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

    const a = await createUser(forge.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    await createUser(forge.db, {
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

  test("the apps screen: every app, its production state in words, its URL", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.press("a");
      await h.until("alice/site");
      const text = h.text();
      expect(text).toContain("failed");
      expect(text).toContain(`http://site.${DOMAIN}:${servers.port}`);
    } finally {
      h.stop();
    }
  }, 30_000);

  test("the app screen: the environment, its error, the log, the runs", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.press("a");
      await h.until("alice/site");
      await h.press("enter");
      await h.until("production");
      // The failure is a sentence, on the row and in the panel.
      expect(h.text()).toContain(`failed: ${NOT_AN_APP}`);
      expect(h.text()).toContain("slug site");

      // `enter` opens the deploy's log; the last line is the reason.
      await h.press("enter");
      await h.until("deploy production of alice/site");
      expect(h.text()).toContain(`failed: ${NOT_AN_APP}`);
      expect(h.text()).toContain("deploy production");

      // A line written to the log now lands on screen without a keypress:
      // the subscription was taken before the file was read.
      appendRunLog(dataDir, productionRun.id, "a fresh line from the test");
      await h.until("a fresh line from the test");

      // Back on the app screen, `l` lists every run of the repository.
      await h.press("esc");
      await h.until("slug site");
      await h.press("l");
      await h.until("deploy production");
      expect(h.text()).toContain("failed");
      expect(h.text()).toContain(NOT_AN_APP);
    } finally {
      h.stop();
    }
  }, 30_000);

  test("the run screen refuses nothing quietly: a finished run cannot be cancelled", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.press("a");
      await h.until("alice/site");
      await h.press("enter", "enter");
      await h.until("deploy production of alice/site");
      // `x` is disabled on a finished run: the key does nothing and the help
      // bar says so rather than offering a cancel that would be refused.
      await h.press("x");
      expect(h.text()).not.toContain("Cancel this run");
    } finally {
      h.stop();
    }
  }, 30_000);

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

      // The crew's work on the issue is a card; `enter` from it opens the run.
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
      await h.until("agent robo");
      expect(h.text()).toContain("cloning alice/site");
      expect(h.text()).toContain("opened pull #2 with the melody");

      // The repository's runs list names the conversation each run is
      // about, from one grouped read; inside the issue that would only
      // repeat the page, so the card above did not.
      await h.push((s, ctx) => runsScreen(s, ctx, site));
      await h.until(`agent robo · #${issue.number} Make the site sing`);
      expect(h.text()).toContain("deploy production");
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

  test("settings: the app tab, require checks, and the crew", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.push((s, ctx) => settingsScreen(s, ctx, site));
      // The screen was handed the row from before the pull test turned the
      // gate on; it reads the row live rather than trusting the snapshot.
      await h.until("a pull needs a passing deploy");
      await h.press("C");
      await h.until("settings saved");
      expect(getRepoById(forge.db, site.id)?.requireChecks).toBe(false);
      expect(h.text()).not.toContain("a pull needs a passing deploy");

      await h.press("tab", "tab", "tab");
      await h.until("this repository runs");
      expect(h.text()).toContain("site");
      expect(h.text()).toContain(`http://site.${DOMAIN}:${servers.port}`);

      await h.press("tab");
      await h.until("robo");
      expect(h.text()).toContain("sonnet");
      await h.press("d");
      await h.until("Remove robo from the crew");
      await h.press("right", "enter");
      await h.until("robo is off the crew");
      await h.press("a");
      await h.until("Add to the crew");
      await h.press("enter");
      await h.until("robo is on the crew");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("the crew screen: the roster, a new agent, and retiring one", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.press("A");
      await h.until("Account");
      await h.press("c");
      await h.until("robo");
      expect(h.text()).toContain("sonnet");
      expect(h.text()).toContain("I write small, careful patches.");
      // No crew was started for this forge, and the screen says so.
      expect(h.text()).toContain("the crew is not running on this forge");

      await h.press("n");
      await h.until("Username");
      await h.type("pixel");
      await h.press("enter");
      await h.until("Display name");
      await h.press("enter");
      await h.until("Model");
      await h.press("enter");
      await h.until("Brief");
      await h.press("enter");
      await h.until("Budget per run");
      await h.type("2.5");
      await h.press("enter");
      await h.until("pixel is on the crew");
      expect(h.text()).toContain("$2.50/run");
      expect(getAgentByName(forge.db, "pixel")?.budgetUsd).toBe(2.5);

      await h.select("pixel");
      await h.press("d");
      await h.until("Retire pixel");
      await h.press("right", "enter");
      await h.until("pixel retired");
      expect(getAgentByName(forge.db, "pixel")).toBeUndefined();
    } finally {
      h.stop();
    }
  }, 30_000);

  test("a non-admin cannot reach the crew's verbs", async () => {
    const bob = (await import("../src/core/users.ts")).getUserByName(
      forge.db,
      "bob",
    )!;
    const h = boot(forge, identityFor(bob));
    try {
      await h.press("A");
      await h.until("Account");
      expect(h.text()).not.toContain("crew");
      await h.press("c");
      expect(h.text()).not.toContain("Crew");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("the dashboard: an Apps pane and an On you pane, both enterable", async () => {
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
      await h.until("Apps");
      expect(h.text()).toContain("On you");
      expect(h.text()).toContain("Tune the drums");
      // The apps pane is first in the tab order, one step back from repos.
      await h.press("shift+tab", "enter");
      await h.until("slug site");
      await h.press("esc");
      // repos → activity → on you.
      await h.press("tab", "tab", "enter");
      await h.until("assigned to alice");
      expect(h.text()).toContain("Tune the drums");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("T on the app screen: tell the crew, and the free builder takes it", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.press("a");
      await h.until("alice/site");
      await h.press("enter");
      await h.until("slug site");
      await h.press("T");
      await h.until("Tell the crew");
      await h.type("Make the header pop");
      await h.press("enter");
      await h.until("robo is on it");
      const told = listIssues(forge.db, site.id, { state: "all" }).find(
        (i) => i.title === "Make the header pop",
      );
      expect(told?.assigneeId).toBe(robo.user.id);
    } finally {
      h.stop();
    }
  }, 30_000);

  test("N on the dashboard reaches New app directly, with no detour through Apps", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.until("Apps");
      await h.press("N");
      await h.until("New app");
      await h.press("esc");
      // Esc discarded the flow: the dashboard is back underneath it.
      await h.until("Apps");
    } finally {
      h.stop();
    }
  }, 30_000);

  // Last on purpose: it starts a real deploy of the scaffold in the
  // background, and nothing after it should have to share the machine.
  test("new app, the golden path: a name, a sentence, who sees it, who works on it", async () => {
    const h = boot(forge, identityFor(alice));
    try {
      await h.press("a");
      await h.until("alice/site");
      await h.press("n");
      await h.until("New app");
      await h.type("notes");
      await h.press("enter");
      await h.until("What should notes do?");
      await h.type("A place for notes");
      await h.press("enter");
      await h.until("Who may see it?");
      await h.press("enter");
      await h.until("Who works on it?");
      await h.select("robo");
      await h.press("enter");
      // The toast names the URL and the agent; the repository opens beneath.
      await h.until(
        `notes: starting at http://notes.${DOMAIN}:${servers.port}`,
      );
      expect(h.text()).toContain("robo is on #1");
      const repo = getRepo(forge.db, "alice", "notes");
      expect(repo).toBeDefined();
      if (repo === undefined) return;
      expect(repo.visibility).toBe("private");
      expect(getAppByRepo(forge.db, repo.id)?.slug).toBe("notes");
      const first = getIssue(forge.db, repo.id, 1);
      expect(first?.title).toBe("Build notes");
      expect(first?.assigneeId).toBe(robo.user.id);
    } finally {
      h.stop();
    }
  }, 60_000);
});
