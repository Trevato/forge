/**
 * Migrate from the terminal: pick a repository from a connected origin, pick
 * the branch the app lives on, put a crew on it, and end on the repository
 * with the crew's brief naming that branch. The origin is the fake forge
 * from `migrate.test.ts`'s world; the clone is real smart HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { connectOrigin } from "../src/actions/origins.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listIssues } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { runGitCapture } from "../src/git/env.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let fake: FakeForge;
let alice: User;
let tipOfWork = "";
let secretToken = "";
let base = "";

const identity = (user: User) => ({
  sshUsername: user.username,
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-migrate-"));
  app = createApp({ dataDir: dir, port: 0, migrateFromPrivateHosts: true });
  servers = await serve(app);
  base = `http://127.0.0.1:${servers.port}`;
  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.test`,
      adminIfFirst,
    });
    if (!made.ok) throw new Error(String(made.error));
    promote(app.db, made.value);
    return made.value;
  };
  alice = await person("alice", true);
  const octo = await person("octo");
  const secret = createToken(app.db, octo.id, "upstream", "rw").token;
  secretToken = secret;

  // The "upstream": two branches, the app on `work`.
  const made = await createRepo(app, octo, { name: "widgets", visibility: "private" });
  if (!made.ok) throw new Error(made.error);
  for (const [branch, path] of [
    ["main", "README.md"],
    ["work", "app.ts"],
  ] as const) {
    const done = await commitToBranch(app, octo, made.value, {
      branch,
      message: `on ${branch}`,
      files: [{ path, content: `${branch}\n` }],
    });
    if (!done.ok) throw new Error(String(done.error));
  }
  const dirOf = repoDir(app.reposRoot, "octo", "widgets");
  const sha = async (ref: string) =>
    (await runGitCapture(["rev-parse", ref], { cwd: dirOf })).stdout.trim();
  tipOfWork = await sha("work");

  const state = newFakeState("forgejo", "octo", secret);
  state.repos.push({
    id: 5,
    fullName: "octo/widgets",
    description: "gears",
    cloneUrl: `${base}/octo/widgets.git`,
    htmlUrl: `${base}/octo/widgets`,
    defaultBranch: "main",
    private: true,
  });
  state.branches.set("octo/widgets", [
    { name: "main", sha: await sha("main") },
    { name: "work", sha: tipOfWork },
  ]);
  // `main` was touched last, by somebody else; `work` is octo's own.
  state.commits.set("octo/widgets", [
    { sha: await sha("main"), message: "on main", authorName: "Zed", login: "zed", date: "2026-10-19T10:00:00Z" },
    { sha: tipOfWork, message: "on work", authorName: "Octo", login: "octo", date: "2026-10-01T10:00:00Z" },
  ]);
  // A public repository for the paste-a-URL path.
  const pub = await createRepo(app, octo, { name: "pub", visibility: "public" });
  if (!pub.ok) throw new Error(pub.error);
  const pubDone = await commitToBranch(app, octo, pub.value, {
    branch: "main",
    message: "hello",
    files: [{ path: "README.md", content: "hi\n" }],
  });
  if (!pubDone.ok) throw new Error(String(pubDone.error));
  // Repositories whose branches are none, or cannot be read.
  for (const [id, fullName] of [[7, "octo/empty"], [8, "octo/flaky"]] as const)
    state.repos.push({ id, fullName, cloneUrl: `${base}/${fullName}.git`, defaultBranch: "main", private: false });
  state.branches.set("octo/empty", []);
  state.branches.set("octo/flaky", [{ name: "main", sha: "a".repeat(40) }]);
  fake = serveFakeForge(state);
  forgetProviders(dir);
  const connected = await connectOrigin(app, alice, { host: fake.url, token: secret });
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));

  const agent = await createAgent(app, alice, { username: "porter", model: "", brief: "Moves things in." });
  if (!agent.ok) throw new Error(String(agent.error));
}, 30_000);

afterAll(async () => {
  fake.stop();
  servers.stop();
  app.close();
  forgetProviders(dir);
  await rm(dir, { recursive: true, force: true });
});

describe("migrate from the terminal", () => {
  test("pick a repository, the person's own newest branch is first, a crew goes on it, and it ends on the repository", async () => {
    const terminal = headlessTerminal(120, 40);
    const { app: tui } = createForgeApp(app, identity(alice), { terminal, exitHooks: false });
    tui.start();
    try {
      await settleApp(tui);
      terminal.feed("M");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("octo/widgets");
      expect(tui.screen.toText()).toContain("private");

      terminal.feed("/widgets\r"); // filter, then
      terminal.feed("\r"); // the repository: its branches
      await settleApp(tui);
      const branches = tui.screen.toText();
      expect(branches).toContain("Branch of octo/widgets");
      // `main` is newer, but `work` is octo's own, so it is on top and suggested.
      expect(branches.indexOf("work")).toBeLessThan(branches.indexOf("main"));
      expect(branches).toContain("suggested");

      terminal.feed("\r"); // take the suggestion
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("branch work");

      terminal.feed("\t\t\t "); // owner, visibility, agent → porter
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("porter");
      terminal.feed("\x04"); // ctrl+d: migrate
      await until(() => listIssues(app.db, getRepo(app.db, "alice", "widgets")?.id ?? "", { kind: "issue", state: "open" }).length === 1);
      await settleApp(tui);

      const repo = getRepo(app.db, "alice", "widgets")!;
      expect(repo.defaultBranch).toBe("work");
      const head = await runGitCapture(["rev-parse", "work"], { cwd: repoDir(app.reposRoot, "alice", "widgets") });
      expect(head.stdout.trim()).toBe(tipOfWork);
      const brief = listIssues(app.db, repo.id, { kind: "issue", state: "open" })[0]!;
      expect(brief.assigneeName).toBe("porter");
      expect(brief.body).toContain("The app is on the branch `work`");
      // Done lands on the repository.
      await until(() => tui.screen.toText().includes("alice/widgets"));
    } finally {
      tui.stop?.();
    }
  }, 60_000);

  /** A terminal for `user` (or nobody), with `body` run and the terminal always stopped. */
  async function withTui(
    user: User | undefined,
    body: (h: { tui: ReturnType<typeof createForgeApp>["app"]; terminal: ReturnType<typeof headlessTerminal> }) => Promise<void>,
  ): Promise<void> {
    const terminal = headlessTerminal(120, 40);
    const id = user === undefined ? { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user } : identity(user);
    const { app: tui } = createForgeApp(app, id, { terminal, exitHooks: false });
    tui.start();
    try {
      await settleApp(tui);
      await body({ tui, terminal });
    } finally {
      tui.stop?.();
    }
  }

  test("u pastes a URL: an empty address is told so, the name comes from the URL, the branch step is skipped, and a blank name keeps the source's", () =>
    withTui(alice, async ({ tui, terminal }) => {
      terminal.feed("Mu");
      await settleApp(tui);
      terminal.feed("\r");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Paste an address first.");
      terminal.feed(`${base}/octo/pub.git\r`);
      await settleApp(tui);
      const form = tui.screen.toText();
      expect(form).toContain(`from ${base}/octo/pub.git`);
      expect(form).not.toContain("Branch of");
      expect(form).not.toContain("· branch ");
      expect(form).toContain("pub");
      terminal.feed("\x7f\x7f\x7f"); // clear the name
      terminal.feed("\x04");
      await until(() => getRepo(app.db, "alice", "pub") !== undefined);
      await until(() => tui.screen.toText().includes("alice/pub"));
    }));

  test("a refusal is shown on the form and nothing is made; a clone that fails shows on the card", () =>
    withTui(alice, async ({ tui, terminal }) => {
      terminal.feed("Mu");
      await settleApp(tui);
      terminal.feed(`${base}/octo/missing.git\r`);
      await settleApp(tui);
      terminal.feed("\x7f\x7f\x7f\x7f\x7f\x7f\x7f"); // "missing" → ""
      terminal.feed("a b!");
      terminal.feed("\x04");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Names start with a letter or digit");
      expect(getRepo(app.db, "alice", "a b!")).toBeUndefined();

      // Fix the name: the clone itself cannot work, so the job fails.
      terminal.feed("\x7f\x7f\x7f"); // "a b!" → ""
      terminal.feed("gone");
      terminal.feed("\x04");
      await until(() => tui.screen.toText().includes("could not be read") || tui.screen.toText().includes("\u2717"));
      await settleApp(tui);
      const card = tui.screen.toText();
      expect(card).toContain("Migrating");
      expect(card).toContain("\u2717");
      expect(getRepo(app.db, "alice", "gone")).toBeUndefined();
    }));

  test("signed out: M does nothing and the palette does not offer it", () =>
    withTui(undefined, async ({ tui, terminal }) => {
      terminal.feed("M");
      await settleApp(tui);
      expect(tui.screen.toText()).not.toContain("Migrate a repository");
      const ids = forgeCommands(new Session(app, { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: undefined }))({} as never).map((c) => c.id);
      expect(ids).not.toContain("migrate");
      expect(forgeCommands(new Session(app, identity(alice)))({} as never).map((c) => c.id)).toContain("migrate");
    }));

  test("a repository with no branches, and an origin that cannot be read, are told in words", () =>
    withTui(alice, async ({ tui, terminal }) => {
      terminal.feed("M");
      await settleApp(tui);
      terminal.feed("/empty\r\r");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("octo/empty has no branches");

      terminal.feed("/\x7f\x7f\x7f\x7f\x7f\x7f"); // clear the filter, then ask for flaky
      terminal.feed("\x1b");
      await settleApp(tui);
      terminal.feed("/flaky\r");
      fake.state.rateLimitFor = 50;
      terminal.feed("\r");
      await settleApp(tui);
      fake.state.rateLimitFor = 0;
      expect(tui.screen.toText()).toContain("Could not reach the origin. Try again.");
    }));

  test("an origin that does not answer is named, and the others are still listed", async () => {
    const erin = await createUser(app.db, { origin: "seed", trusted: true, username: "erin", email: "erin@forge.test" });
    if (!erin.ok) throw new Error(String(erin.error));
    promote(app.db, erin.value);
    const down = serveFakeForge(newFakeState("forgejo", "ghost", "tok-ghost"));
    try {
      for (const [host, token] of [[fake.url, secretToken], [down.url, "tok-ghost"]] as const) {
        const connected = await connectOrigin(app, erin.value, { host, token });
        if (!connected.ok) throw new Error(JSON.stringify(connected.error));
      }
      down.state.rateLimitFor = 1000;
      await withTui(erin.value, async ({ tui, terminal }) => {
        terminal.feed("M");
        await settleApp(tui);
        const text = tui.screen.toText();
        expect(text).toContain("octo/widgets");
        expect(text).toContain("Could not reach ghost. The others are listed.");
      });
    } finally {
      down.stop();
    }
  });
});

describe("migrate from the terminal: afterwards", () => {
  test("the form offers leave by default; choosing archive archives the source with one PATCH {archived:true}", async () => {
    const terminal = headlessTerminal(120, 40);
    const { app: tui } = createForgeApp(app, identity(alice), { terminal, exitHooks: false });
    tui.start();
    try {
      await settleApp(tui);
      terminal.feed("M");
      await settleApp(tui);
      terminal.feed("/widgets\r"); // filter, then
      terminal.feed("\r"); // the repository: its branches
      await settleApp(tui);
      terminal.feed("\r"); // the suggested branch → form
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("afterwards  leave it alone");
      terminal.feed("\x7f\x7f\x7f\x7f\x7f\x7f\x7f"); // clear the name
      terminal.feed("archived-copy");
      terminal.feed("\t\t\t\t\t "); // owner, visibility, agent, autonomy, afterwards → archive
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("afterwards  archive it");
      fake.state.requests.length = 0;
      terminal.feed("\x04");
      await until(() => getRepo(app.db, "alice", "archived-copy") !== undefined);
      await until(() => fake.state.requests.some((r) => r.method === "PATCH"));
      const writes = fake.state.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");
      expect(writes.length).toBe(1);
      expect(writes[0]!.method).toBe("PATCH");
      expect(JSON.parse(writes[0]!.body)).toEqual({ archived: true });
    } finally {
      tui.stop?.();
    }
  }, 60_000);
});
