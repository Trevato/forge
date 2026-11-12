/**
 * Tell the crew from a repository screen's palette (#1788): the row is
 * there for who may direct the crew and for no one else, and sending it is
 * the same `tell()` the web row calls, answered in the web flash's words.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listIssues, MAX_BODY } from "../src/core/issues.ts";
import { createUser, type User } from "../src/core/users.ts";
import { tellAnswer } from "../src/tui/screens/tell.ts";
import { tell, toldWords, TOO_LONG_WORDS, UNVERIFIED_WORDS, type Told } from "../src/actions/tell.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";
import type { Repo } from "../src/core/repos.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

async function palette(user: User, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 48);
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
  dir = await mkdtemp(join(tmpdir(), "forge-tui-tell-"));
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

describe("tell the crew in the terminal", () => {
  test("the owner's palette has the row", async () => {
    expect(await palette(alice, [":", "tell"])).toContain("alice/lobby — Tell the crew");
  });

  test("a reader who may not direct the crew sees no row", async () => {
    expect(await palette(bob, [":"])).not.toContain("Tell the crew");
  });

  test("one line is told, and the answer is the web's words", async () => {
    const text = await palette(alice, [":", "tell", "\r", ..."paint the door red".split(""), "\r"]);
    expect(text).toContain("Nobody is on the crew to take it yet");
    expect(listIssues(app.db, repo.id, {}).some((i) => i.title === "paint the door red")).toBe(true);
  });

  test("a tell from a page carries its page and pull, and bob has no such row", async () => {
    const keys = [":", "from a page", "\r", ..."https://notes.apps.test/a".split(""), "\r", "7", "\r", ..."move the button".split(""), "\r"];
    const text = await palette(alice, keys);
    expect(text).toContain("Nobody is on the crew to take it yet");
    const issue = listIssues(app.db, repo.id, {}).find((i) => i.title === "move the button")!;
    expect(issue.body).toContain("- from preview of #7, page /a");
    expect(await palette(bob, [":", "from a page"])).not.toContain("Tell the crew from a page");
  });

  test("a page that is not http(s) keeps the prompt open and tells nothing", async () => {
    const before = listIssues(app.db, repo.id, {}).length;
    const text = await palette(alice, [":", "from a page", "\r", ..."javascript:alert(1)".split(""), "\r"]);
    expect(text).toContain("That is not an http(s) address.");
    expect(listIssues(app.db, repo.id, {}).length).toBe(before);
  });

  test("an empty line says so and tells nothing", async () => {
    const before = listIssues(app.db, repo.id, {}).length;
    const text = await palette(alice, [":", "tell", "\r", "\r"]);
    expect(text).toContain("Say something first.");
    expect(listIssues(app.db, repo.id, {}).length).toBe(before);
  });

  test("a tell that could not be assigned says so, with its number", () => {
    const value = {
      issue: { number: 7 },
      assigned: false,
      routed: { builder: { user: { username: "mason" } }, size: "small", kind: "fix", by: "rule", ms: 1 },
    } as unknown as Told;
    const answer = tellAnswer({ ok: true, value });
    expect(answer.text).toBe(toldWords(value));
    expect(answer.text).toContain("Opened as issue #7, but mason could not take it.");
    expect(answer.text).not.toContain("is on it");
    expect(answer.tone).toBe("danger");
  });

  test("an unverified address gets the shared words", () => {
    expect(tellAnswer({ ok: false, error: "unverified" }).text).toBe(UNVERIFIED_WORDS);
  });

  test("an over-long line gets the page's words", async () => {
    expect(tellAnswer(await tell(app, alice, repo, "x".repeat(MAX_BODY + 1))).text).toBe(TOO_LONG_WORDS);
  });
});
