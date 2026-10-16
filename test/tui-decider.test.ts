/**
 * The decider's day in the terminal: the board's Today line and the rows
 * behind each pile, gated by owner facts — a reader of the repository, or a
 * guest, sees nothing of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { deciderCounts, recordDecision, setOutcome, type DecisionKind } from "../src/core/decisions.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deciderLine, deciderRows, deciderScreen } from "../src/tui/screens/decider.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;
let cards = 0;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

function row(kind: DecisionKind, answer: string, by: string, outcome?: string): void {
  const issue = openIssue(app, alice, repo, { title: `Card ${++cards}` });
  if (!issue.ok) throw new Error(String(issue.error));
  const d = recordDecision(app.db, {
    kind, repoId: repo.id, issueId: issue.value.id, state: {}, answer, p: 0.9, by, ms: 1,
  });
  if (outcome !== undefined) setOutcome(app.db, d.id, outcome);
}

async function screenText(user: User | undefined, keys = ""): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(deciderScreen(session, tui.ctx));
  await settleApp(tui);
  if (keys !== "") {
    terminal.feed(keys);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-decider-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  row("hand", "set_aside", "typesafe", "set_aside");
  row("hand", "set_aside", "typesafe", "set_aside");
  row("retry", "stop", "typesafe");
  row("retry", "stop", "rule"); // the rule's stop is the crew's, not the decider's
  row("hand", "ask_owner", "typesafe", "asked");
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the decider in the terminal", () => {
  test("the owner gets the board's sentence", () => {
    expect(deciderLine(app, alice)).toBe("The decider closed 2, deferred 1, asked you about 1.");
  });

  test("a reader of the repository and a guest get nothing", () => {
    expect(deciderLine(app, bob)).toBeNull();
    expect(deciderLine(app, undefined)).toBeNull();
    expect(deciderRows(app, bob, "closed")).toEqual([]);
  });

  test("each pile lists the rows behind its count, with the card's address", () => {
    expect(deciderRows(app, alice, "closed")).toHaveLength(2);
    expect(deciderRows(app, alice, "deferred")).toHaveLength(1);
    const asked = deciderRows(app, alice, "asked");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.path).toMatch(/^\/alice\/notes\/issues\/\d+$/);
  });

  test("the screen shows the sentence and switches pile with 1, 2, 3", async () => {
    const closed = await screenText(alice);
    expect(closed).toContain("The decider closed 2, deferred 1, asked you about 1.");
    expect(closed).toContain("Card 1");
    expect(closed).not.toContain("Card 5");
    expect(await screenText(alice, "3")).toContain("Card 5");
  });

  test("a reader's screen says the pile is empty in words", async () => {
    expect(await screenText(bob)).toContain("The decider has closed nothing today.");
  });

  test("a large owner is counted whole, past the batch", () => {
    const ids = [...Array.from({ length: 450 }, (_, i) => `x${i}`), repo.id];
    expect(deciderCounts(app.db, ids, "2000-01-01T00:00:00.000Z").closed).toBe(2);
  });
});
