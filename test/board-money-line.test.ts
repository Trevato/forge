/**
 * The board's money line (#11056): one line, "This month · cost $10.00 ·
 * revenue $12.00 · +$2.00", the gap the one link to Settings → Economics,
 * marked by its sign and named for a screen reader, and the slider's
 * position beside it as text.
 *
 * The board reads the real clock, so the prices that spread over the month
 * (the owned box, storage, awake time) are set to zero, and only crew spend
 * recorded now and one minute of cloud at the month's first instant move
 * the figures. In the month's first two minutes that cloud minute is not yet
 * wholly past, so the loss is skipped then rather than read half-counted. By hand, with a 20% margin and cloud at $300 an hour:
 *   positive: $10 of crew → cost 10.00, revenue 10 × 1.2 = 12.00, gap +2.00
 *   negative: and a cloud minute, 300 / 60 = 5.00 of cost that no statement
 *             charges (awake time is priced at zero) → cost 15.00,
 *             revenue 12.00, gap −3.00
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { readForgeMoney } from "../src/actions/money.ts";
import { createRepo } from "../src/actions/repos.ts";
import { closeAwake, openAwake } from "../src/core/meter.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage, type UsageEntry } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getPrices, setEconomics, setPrices } from "../src/settings/economics.ts";

describe("the board's money line", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie = "";
  let notesId = "";

  const monthStart = `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const inFirstMinutes = Date.now() - Date.parse(monthStart) < 120_000;
  const spend = (repoId: string, usd: number) => {
    const entry: UsageEntry = {
      runId: createRun(app.db, { repoId, kind: "agent" }).id,
      repoId,
      issueId: null,
      agentId: null,
      subscriptionId: null,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: usd,
      wallMs: 1,
      outcome: "ok",
      at: new Date().toISOString(),
    };
    recordUsage(app.db, entry);
  };
  /** The money section of the board, whitespace folded to single spaces. */
  const moneySection = async (): Promise<string> => {
    const html = await (await fetch(`${servers.url}/board`, { headers: { cookie } })).text();
    const m = html.match(/<section class="money-line"[\s\S]*?<\/section>/);
    if (!m) throw new Error("no money line on the board");
    return m[0].replace(/\s+/g, " ");
  };
  const gapLink = (sign: string, figure: string): string =>
    `<a class="money-gap num" data-sign="${sign}" href="/settings/economics" aria-label="Month gap ${figure}, open Economics settings">${figure}</a>`;
  const words = (section: string): string => section.replace(/<svg[\s\S]*<\/svg>/, "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-board-money-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const repo = await createRepo(app, alice, { name: "notes", visibility: "public" });
    if (!repo.ok) throw new Error("repo");
    notesId = repo.value.id;
    setPrices(
      app.db,
      {
        ...getPrices(app.db),
        ownedMonthCents: 0,
        cloudHourCents: 30_000,
        storageGbMonthCents: 0,
        awakePriceHourCents: 0,
        storagePriceGbMonthCents: 0,
      },
      alice.id,
    );
    setEconomics(app.db, { position: 62, marginPct: 20 }, alice.id);
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with nothing spent the slot is there, even, at zero", async () => {
    const section = await moneySection();
    expect(words(section)).toContain("This month · cost $0.00 · revenue $0.00 · $0.00");
    expect(section).toContain(gapLink("even", "$0.00"));
  });

  test("a profit: the line, the gap the one link, the slider beside it as text", async () => {
    spend(notesId, 10);
    const section = await moneySection();
    expect(words(section)).toContain("This month · cost $10.00 · revenue $12.00 · +$2.00");
    expect(section).toContain(gapLink("up", "+$2.00"));
    expect(words(section)).toContain("Today: gap +$2.00 · Economics slider: 62");
    expect(section.match(/<a /g)?.length).toBe(1);
    // The same function as the statement's sum: the board says what readForgeMoney says.
    const m = readForgeMoney(app, alice);
    if (!m.ok) throw new Error(m.error);
    expect(m.value.thisMonth).toEqual({ cost: 10, revenue: 12, gap: 2 });
  });

  test.skipIf(inFirstMinutes)("a loss: the gap marked down, the slider still beside it", async () => {
    // A minute of cloud from the month's first instant, already past.
    const start = monthStart;
    openAwake(app.db, { repoId: notesId, env: "pr-1", placement: "cloud", at: start });
    closeAwake(app.db, { repoId: notesId, env: "pr-1", at: new Date(Date.parse(start) + 60_000).toISOString() });
    const section = await moneySection();
    expect(words(section)).toContain("This month · cost $15.00 · revenue $12.00 · -$3.00");
    expect(section).toContain(gapLink("down", "-$3.00"));
    expect(words(section)).toContain("Economics slider: 62");
    expect(section.match(/<a /g)?.length).toBe(1);
  });
});
