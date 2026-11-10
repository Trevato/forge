/**
 * The terminal's money screen (src/tui/screens/money.ts, #510): a site
 * admin opens "Money" from the palette and reads the month, today, the
 * slider and the thirty days — the board's figures from the same read; a
 * repository's admin opens "owner/name — Money" for the app's month. A
 * member and a guest are offered neither and, were the screen reached, see
 * no figures. Figures come from `readForgeMoney`/`readAppMoney`, worked by
 * hand in test/money.test.ts; here the rows are checked against them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { readAppMoney, readForgeMoney } from "../src/actions/money.ts";
import { createRepo } from "../src/actions/repos.ts";
import { closeAwake, openAwake } from "../src/core/meter.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getPrices, setEconomics, setPrices } from "../src/settings/economics.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { appMoneyRows, entry, forgeMoneyRows, moneyCommands, moneyScreen } from "../src/tui/screens/money.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

const NOW = "2026-11-10T12:00:00.000Z";

let dir: string;
let app: App;
let admin: User;
let bob: User;
let notes: Repo;

async function drive(user: User | undefined, keys: string[], start: "home" | "repo" | "forge" | "app"): Promise<string> {
  const terminal = headlessTerminal(140, 50);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user?.username ?? "guest", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  if (start === "repo") tui.ctx.push(repoScreen(session, tui.ctx, local(session, notes)));
  if (start === "forge") tui.ctx.push(moneyScreen(session, tui.ctx));
  if (start === "app") tui.ctx.push(moneyScreen(session, tui.ctx, notes));
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
  dir = await mkdtemp(join(tmpdir(), "forge-tui-money-"));
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
  openAwake(app.db, { repoId: notes.id, env: "production", placement: "owned", at: "2026-11-02T00:00:00.000Z" });
  closeAwake(app.db, { repoId: notes.id, env: "production", at: "2026-11-02T10:00:00.000Z" });
  setPrices(app.db, { ...getPrices(app.db), ownedMonthCents: 30_000, awakePriceHourCents: 10 }, admin.id);
  setEconomics(app.db, { position: 62, marginPct: 20 }, admin.id);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the terminal's money screen", () => {
  test("the forge's rows say the board's figures, in plain words", () => {
    const m = readForgeMoney(app, admin, NOW);
    if (!m.ok) throw new Error(m.error);
    const rows = forgeMoneyRows(m.value);
    // Box 300 × 9.5 / 30 = 95.00 against 10 h × $0.10 = 1.00 of revenue.
    expect(rows[0]).toEqual({ title: "This month (2026-11)", meta: "cost $95.00 · revenue $1.00 · gap -$94.00" });
    expect(rows[1]).toEqual({ title: "Today (2026-11-10)", meta: "cost $5.00 · revenue $0.00 · gap -$5.00" });
    expect(rows[2]).toEqual({ title: "Economics slider", meta: "62" });
    // Thirty days, newest first.
    expect(rows).toHaveLength(3 + 30);
    expect(rows[3]!.title).toBe("2026-11-10");
    expect(rows[32]!.title).toBe("2026-10-12");
  });

  test("an app's rows: its month, where it was awake, its share of the server", () => {
    const m = readAppMoney(app, admin, notes, NOW);
    if (!m.ok) throw new Error(m.error);
    expect(appMoneyRows(m.value)).toEqual([
      { title: "This month (2026-11)", meta: "cost $95.00 · revenue $1.00 · gap -$94.00" },
      { title: "Awake", meta: "10.0 h · 100% on the forge's own server · 0% on cloud" },
      { title: "Share of the forge's own server", meta: "100%" },
    ]);
  });

  test("a site admin opens Money from the palette; a repository's admin its app's", async () => {
    const forge = await drive(admin, [":", "Money", "\r"], "home");
    expect(forge).toContain("This month (");
    expect(forge).toContain("Economics slider");
    const one = await drive(admin, [":", "notes — Money", "\r"], "repo");
    expect(one).toContain("alice/notes — Money");
    expect(one).toContain("on the forge's own server");
  });

  test("a member and a guest are offered neither and see no figures", async () => {
    expect(entry.offered({ app, user: bob } as never)).toBe(false);
    expect(entry.offered({ app, user: undefined } as never)).toBe(false);
    expect(entry.offered({ app, user: { ...admin, kind: "agent" } } as never)).toBe(false);
    expect(entry.offered({ app, user: admin } as never)).toBe(true);
    const ctx = {} as never;
    expect(moneyCommands({ app, user: bob } as never, ctx, notes)).toEqual([]);
    expect(moneyCommands({ app, user: undefined } as never, ctx, notes)).toEqual([]);
    expect(moneyCommands({ app, user: admin } as never, ctx, notes)).toHaveLength(1);
    for (const who of [bob, undefined]) {
      for (const start of ["forge", "app"] as const) {
        const text = await drive(who, [], start);
        expect(text).not.toContain("This month");
        expect(text).not.toContain("$");
      }
    }
  });
});
