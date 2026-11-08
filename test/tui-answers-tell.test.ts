/**
 * The terminal's answers screen tells the crew more with `t` (#7416): the
 * row's page goes in as the tell's page, the new tell joins the list, the
 * screen's own gate stays, and a refused tell answers in the tell's words.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { tell, UNVERIFIED_WORDS } from "../src/actions/tell.ts";
import { createApp, type App } from "../src/app.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { answerLines, answersScreen } from "../src/tui/screens/answers.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir = "";
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

const issues = () => listIssues(app.db, repo.id, { state: "all", limit: 50 });

/** The answers screen for `user`, fed `keys`; the text after each step. */
async function drive(user: User, keys: string[]): Promise<{ text: string; count: number }> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  tui.push(answersScreen(session, tui.ctx, repo));
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  const count = answerLines(session, repo).length;
  tui.stop();
  return { text, count };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-answers-tell-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [
      { path: "package.json", content: '{"name":"notes","scripts":{"start":"bun run server.ts"}}\n' },
      { path: "server.ts", content: "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n" },
    ],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const enabled = await enableApp(app, alice, repo, { slug: "notes" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  const first = await tell(app, alice, repo, "Add a footer.");
  if (!first.ok) throw new Error(first.error);
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("t on the answers screen", () => {
  test("the key hints name it", async () => {
    expect((await drive(alice, [])).text).toMatch(/\bt +tell\b/);
  });

  test("tells from the row's page, and the new tell is in the list when the screen comes back", async () => {
    const row = issues().find((i) => i.title === "Add a footer.")!;
    const before = issues().length;
    const seen = await drive(alice, ["t", ..."Make it blue too.", "\r"]);
    const after = issues();
    expect(after.length).toBe(before + 1);
    const told = after.find((i) => i.title === "Make it blue too.")!;
    expect(told).toBeDefined();
    const page = `/alice/notes/issues/${row.number}`;
    expect(told.body).toContain(`Told from [${page}](${page})`);
    expect(seen.text).toContain("Make it blue too.");
    expect(seen.count).toBe(2);
  });

  test("an unverified owner hears the tell's own words and opens nothing", async () => {
    const before = issues().length;
    app.db.query("UPDATE email_check SET verified_at = NULL").run();
    try {
      const seen = await drive(alice, ["t", ..."Unseen.", "\r"]);
      expect(seen.text).toContain(UNVERIFIED_WORDS.slice(0, 30));
    } finally {
      proveAll(app);
    }
    expect(issues().length).toBe(before);
  });

  test("the owner's `t` opens the prompt", async () => {
    expect((await drive(alice, ["t"])).text).toContain("Tell the crew");
  });

  test("a stranger behind the screen's gate gets no prompt", async () => {
    expect((await drive(bob, ["t"])).text).not.toContain("Tell the crew");
  });

  test("a stranger's `t` and words open nothing", async () => {
    const before = issues().length;
    await drive(bob, ["t", ..."Sneak in.", "\r"]);
    expect(issues().length).toBe(before);
  });
});
