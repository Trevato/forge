/**
 * The terminal's pull screen holds a pull with `h` and a reason, and lets it
 * go with `h` again, through the same actions MCP `hold` uses (#7257).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { setIssueStateThrough } from "../src/actions/issues.ts";
import { getIssue } from "../src/core/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getHold, WHY_MAX } from "../src/core/holds.ts";
import { getPull } from "../src/core/pulls.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-hold-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("h holds with a reason, the header says held, h again releases; an agent has no h", async () => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice: User = made.value;
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const repo = r.value;
  const agent = await createAgent(app, alice, { username: "bot" });
  if (!agent.ok) throw new Error(String(agent.error));
  for (const branch of ["main", "feat"]) {
    const c = await commitToBranch(app, alice, repo, {
      branch,
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
  const o = await openPull(app, alice, repo, {
    title: "Pull feat",
    body: "",
    baseBranch: "main",
    headBranch: "feat",
  });
  if (!o.ok) throw new Error(String(o.error));
  const number = o.value.number;
  const pullId = getPull(app.db, repo.id, number)!.id;

  const open = async (user: User) => {
    const { app: tui, session } = createForgeApp(
      app,
      {
        sshUsername: user.username,
        remoteAddress: "127.0.0.1",
        fingerprint: "SHA256:t",
        user,
      },
      { terminal: headlessTerminal(160, 44), exitHooks: false },
    );
    tui.start();
    tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), number));
    await settleApp(tui);
    const press = async (...keys: string[]) => {
      for (const key of keys)
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    return { tui, press, text: () => tui.screen.toText() };
  };

  const h = await open(alice);
  try {
    // An empty reason and an over-long one stay in the prompt with the action's words.
    await h.press("h", "enter");
    expect(h.text()).toContain("Hold #");
    expect(h.text()).toContain("empty why");
    expect(getHold(app.db, pullId)).toBeUndefined();
    await h.press(..."x".repeat(WHY_MAX + 1));
    await h.press("enter");
    expect(h.text()).toContain("Hold #");
    expect(h.text()).toContain("why too long");
    expect(getHold(app.db, pullId)).toBeUndefined();
    await h.press(...Array(WHY_MAX + 1).fill("backspace"));
    await h.press(..."wait for docs", "enter");
    expect(getHold(app.db, pullId)?.why).toBe("wait for docs");
    expect(h.text()).toContain("held by alice: wait for docs");

    await h.press("h");
    expect(h.text()).toContain("Let #");
    await h.press("enter");
    expect(getHold(app.db, pullId)).toBeUndefined();
    expect(h.text()).not.toContain("held by alice");
  } finally {
    h.tui.stop();
  }

  const bot = getUserByName(app.db, "bot")!;
  const a = await open(bot);
  try {
    await a.press("h");
    expect(a.text()).not.toContain("Hold #");
    expect(getHold(app.db, pullId)).toBeUndefined();
  } finally {
    a.tui.stop();
  }

  // A reader has no h and writes no hold.
  const bobMade = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bobMade.ok) throw new Error(String(bobMade.error));
  const reader = await open(bobMade.value);
  try {
    await reader.press("h");
    expect(reader.text()).not.toContain("Hold #");
    expect(getHold(app.db, pullId)).toBeUndefined();
  } finally {
    reader.tui.stop();
  }

  // A closed pull offers no hold prompt.
  const issue = getIssue(app.db, repo.id, number)!;
  const closed = await setIssueStateThrough(app, alice, repo, issue, "closed");
  if (!closed.ok) throw new Error(String(closed.error));
  const c = await open(alice);
  try {
    await c.press("h");
    expect(c.text()).not.toContain("Hold #");
    expect(getHold(app.db, pullId)).toBeUndefined();
  } finally {
    c.tui.stop();
  }
}, 60_000);
