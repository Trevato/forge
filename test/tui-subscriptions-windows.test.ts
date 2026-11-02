/** The terminal's Subscriptions screen says each window as Settings › Subscriptions does (#8056). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowParts, windowWords } from "../src/actions/standing_words.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { escapeHtml } from "../src/web/html.ts";
import { createRun } from "../src/core/runs.ts";
import { noteLimit, standing } from "../src/core/standing.ts";
import { addSubscription, getSubscriptionByName } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settlePalette, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("windows on the terminal's subscriptions screen", () => {
  let dataDir: string;
  let forge: Forge;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-subwin-"));
    forge = createApp({ dataDir, port: 0 });
    servers = await serve(forge);
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    for (const name of ["seen", "unseen"]) {
      const added = addSubscription(forge.db, dataDir, { name, token: `sk-ant-oat01-win-${name}` });
      if (!added.ok) throw new Error(added.error);
    }
    const seen = getSubscriptionByName(forge.db, "seen")!;
    const owner = getUserByName(forge.db, "alice")!;
    const repoId = id();
    forge.db
      .query(
        `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch)
         VALUES (?1, ?2, 'r', 'private', '', 'main')`,
      )
      .run(repoId, owner.id);
    const at = new Date(Date.now() - 3_600_000).toISOString();
    recordUsage(forge.db, {
      runId: createRun(forge.db, { repoId, kind: "agent" }).id,
      repoId,
      issueId: null,
      agentId: null,
      subscriptionId: seen.id,
      tokensIn: 100,
      tokensOut: 10,
      costUsd: 3.1,
      wallMs: 60_000,
      outcome: "ok",
      at,
    });
    noteLimit(forge.db, seen.id, {
      window: "5h",
      resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      observedAt: at,
      said: "You've hit your session limit",
    });
  });
  afterAll(async () => {
    servers.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function open(cols = 160): Promise<{ text: () => string; press: (k: string) => Promise<void>; stop: () => void }> {
    const terminal = headlessTerminal(cols, 32);
    const user = getUserByName(forge.db, "alice")!;
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    key("k", true);
    for (const ch of "Crew subscriptions") key(ch);
    await settleUntil(app, "each account", { timeoutMs: 4_000 });
    // Typing in the palette arms a 120ms and a 400ms search that Enter does not cancel;
    // left to fire later they land in a test's counted window (#8278).
    await settlePalette(app);
    key("enter");
    await settleUntil(app, "w wakes", { timeoutMs: 4_000 });
    return {
      text: () => app.screen.toText(),
      press: async (k) => {
        key(k);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  const seenWindows = () => standing(forge.db, getSubscriptionByName(forge.db, "seen")!.id, new Date())!.windows;
  const sentences = () => seenWindows().map(windowWords);

  test("every account shows its windows, in the sentence the Settings page is built from", async () => {
    const h = await open();
    const lines = sentences();
    expect(lines[0]).toMatch(/^5-hour: ~\$3\.10 used of ~\$3\.10 \(100%\)/);
    expect(lines[0]).toContain("resets");
    for (const l of lines) expect(h.text()).toContain(l);
    expect(h.text()).toContain("windows not seen yet");
    h.stop();
    // The page says the same pieces, escaped once; only the token count between them is dressed.
    const user = getUserByName(forge.db, "alice")!;
    const page = await (
      await fetch(`${servers.url}/settings/subscriptions`, { headers: { cookie: `forge_session=${createSession(forge.db, user.id).token}` } })
    ).text();
    for (const w of seenWindows()) {
      const { head, tail } = windowParts(w);
      expect(page).toContain(escapeHtml(head));
      expect(page).toContain(escapeHtml(tail));
    }
  });

  test("at 80 columns every sentence is whole on its line", async () => {
    const h = await open(80);
    const screen = h.text().split("\n");
    for (const l of sentences()) expect(screen.some((line) => line.includes(l))).toBe(true);
    h.stop();
  });

  test("where a sentence is wider than the room, the reset time wraps onto a continuation line", async () => {
    const cols = 48;
    const first = sentences()[0]!;
    expect(first.length).toBeGreaterThan(cols - 3);
    const h = await open(cols);
    const screen = h.text().split("\n");
    h.stop();
    const at = screen.findIndex((line) => line.includes("5-hour:"));
    expect(at).toBeGreaterThan(-1);
    expect(screen[at]).not.toContain("resets");
    const rest = screen.slice(at + 1, at + 3).map((line) => line.trim()).join(" ");
    expect(rest).toContain(`resets ${first.slice(first.indexOf("resets ") + "resets ".length)}`);
  });

  /** Database calls made while `run` goes, counting only those with the screen's own frame on the stack. */
  async function screenQueries(run: () => Promise<void>): Promise<number> {
    const db = forge.db as unknown as { query: (...a: unknown[]) => unknown; prepare: (...a: unknown[]) => unknown };
    const { query, prepare } = db;
    let calls = 0;
    // Other timers in this process share the database, so a call counts only when
    // screens/subscriptions is on its stack; the limit is raised so that frame is never cut off.
    const ours = () => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 200;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = limit;
      return stack.includes("screens/subscriptions");
    };
    db.query = (...a) => (ours() && calls++, query.apply(forge.db, a));
    db.prepare = (...a) => (ours() && calls++, prepare.apply(forge.db, a));
    try {
      await run();
    } finally {
      db.query = query;
      db.prepare = prepare;
    }
    return calls;
  }

  test("moving the cursor redraws from memory: no query reaches the database", async () => {
    const h = await open();
    const calls = await screenQueries(async () => {
      await h.press("j");
      await h.press("k");
    });
    expect(calls).toBe(0);
    expect(h.text()).toContain("windows not seen yet");
    h.stop();
  });

  test("the query counter sees the screen's own reads (it is not vacuous)", async () => {
    let h: Awaited<ReturnType<typeof open>> | undefined;
    const calls = await screenQueries(async () => {
      h = await open();
    });
    expect(calls).toBeGreaterThan(0);
    h?.stop();
  });

  test("an account with no window seen says so, whichever row the cursor is on", async () => {
    const h = await open();
    await h.press("g");
    await h.press("j");
    expect(h.text()).toContain("windows not seen yet");
    h.stop();
  });
});
