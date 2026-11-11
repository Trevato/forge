/**
 * The terminal's statement screen (src/tui/screens/statement.ts, #508):
 * from a repository's `:` palette its admin reads a month's lines and total,
 * the same figures the API answers (test/statement.test.ts, by hand); `m`
 * takes a month and refuses one that is not YYYY-MM; `[` and `]` step.
 * Someone who does not administer the repository, or a guest, is offered
 * nothing and, were the screen reached, sees no lines — the gate is
 * `readStatement`'s.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { closeAwake, openAwake } from "../src/core/meter.ts";
import type { Repo } from "../src/core/repos.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getPrices, setEconomics, setPrices } from "../src/settings/economics.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { statementCommands, statementScreen, stepMonth } from "../src/tui/screens/statement.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

const open = [":", "Statement", "\r"];

let dir: string;
let app: App;
let admin: User;
let bob: User;
let notes: Repo;

async function drive(user: User | undefined, keys: string[], direct = false): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user?.username ?? "guest", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(direct ? statementScreen(session, tui.ctx, notes) : repoScreen(session, tui.ctx, local(session, notes)));
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
  dir = await mkdtemp(join(tmpdir(), "forge-tui-statement-"));
  app = createApp({ dataDir: dir, port: 0 });
  for (const [username, first] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    if (username === "alice") admin = made.value;
    else bob = made.value;
  }
  const made = await createRepo(app, admin, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  notes = made.value;
  // October 2026: 84 awake-hours and $50 of crew.
  openAwake(app.db, { repoId: notes.id, env: "production", placement: "owned", at: "2026-10-02T00:00:00.000Z" });
  closeAwake(app.db, { repoId: notes.id, env: "production", at: "2026-10-05T12:00:00.000Z" });
  recordUsage(app.db, {
    runId: null, repoId: notes.id, issueId: null, agentId: null, subscriptionId: null,
    tokensIn: 1, tokensOut: 1, costUsd: 50, wallMs: 1, outcome: "ok", at: "2026-10-10T00:00:00.000Z",
  } as never);
  setPrices(app.db, { ...getPrices(app.db), awakePriceHourCents: 10, storagePriceGbMonthCents: 25 }, admin.id);
  setEconomics(app.db, { position: 50, marginPct: 20 }, admin.id);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the terminal's statement screen", () => {
  test("an admin reads October's lines and total, matching the hand sum", async () => {
    const text = await drive(admin, [...open, "m", "2026-10", "\r"]);
    expect(text).toContain("2026-10 (UTC) · USD");
    // 84 h × $0.10 = $8.40; $50 at cost; 20% × $50 = $10; total $68.40.
    expect(text).toContain("84 awake-hour × $0.1 = $8.40");
    expect(text).toContain("50 USD of crew spend × $1 = $50.00");
    expect(text).toContain("50 USD of crew spend × $0.2 = $10.00");
    expect(text).toContain("$68.40");
  });

  test("[ and ] step a month; a month not YYYY-MM is refused", async () => {
    const back = await drive(admin, [...open, "m", "2026-11", "\r", "["]);
    expect(back).toContain("2026-10 (UTC)");
    expect(back).toContain("$68.40");
    const bad = await drive(admin, [...open, "m", "2026-13", "\r"]);
    expect(bad).toContain("month is YYYY-MM");
    expect(stepMonth("2026-12", 1)).toBe("2027-01");
    expect(stepMonth("2026-01", -1)).toBe("2025-12");
    expect(stepMonth("2000-01", -1)).toBeUndefined();
  });

  test("a non-admin and a guest are offered nothing and see no lines", async () => {
    expect(await drive(admin, [":", "Statement"])).toContain("— Statement");
    expect(await drive(bob, [":", "Statement"])).not.toContain("— Statement");
    const ctx = {} as never;
    expect(statementCommands({ app, user: bob } as never, ctx, notes)).toEqual([]);
    expect(statementCommands({ app, user: undefined } as never, ctx, notes)).toEqual([]);
    for (const who of [bob, undefined]) {
      const text = await drive(who, ["m", "2026-10", "\r"], true);
      expect(text).not.toContain("Total");
      expect(text).not.toContain("$68.40");
      expect(text).not.toContain("Awake time");
    }
  });
});
