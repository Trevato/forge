/**
 * Report a problem from a repository screen's palette (#810): the terminal's
 * door to the toolbar's "Report this page" — one text, one issue, titled by
 * its first line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createRepo } from "../src/actions/repos.ts";
import { reportTitle } from "../src/actions/page-report.ts";
import { createApp, type App } from "../src/app.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { scratchDir } from "./helpers/scratch.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

async function palette(user: User, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, repo)));
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = scratchDir("forge-tui-report-");
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
  const made = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("report a problem in the terminal", () => {
  test("the palette has the row", async () => {
    // Filtered, so the row's presence does not depend on how many others the palette lists.
    expect(await palette(bob, [":", "Report a"])).toContain("alice/lobby — Report a problem");
  });

  test("a text opens an issue titled by its first line", async () => {
    const text = await palette(bob, [":", "report", "\r", ..."the door sticks".split(""), "\r"]);
    expect(text).toContain("opened");
    const issue = listIssues(app.db, repo.id, {}).find((i) => i.title === "the door sticks");
    expect(issue?.body).toBe("the door sticks");
  });

  test("an empty text says so and opens nothing", async () => {
    const before = listIssues(app.db, repo.id, {}).length;
    const text = await palette(bob, [":", "report", "\r", "\r"]);
    expect(text).toContain("Say something first.");
    expect(listIssues(app.db, repo.id, {}).length).toBe(before);
  });

  test("a long first line is cut for the title", () => {
    const title = reportTitle(`${"x".repeat(200)}\nmore`);
    expect(title.length).toBe(78);
    expect(title.endsWith("…")).toBe(true);
  });
});
