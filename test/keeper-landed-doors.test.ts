/**
 * Landed to live and the short commit at every door (#8042): the /releases
 * card, the terminal's Release keeper and MCP `release_keeper` read the same
 * figure from `keeper/landed.ts`. Pull 7 merged at noon; the keeper cut at
 * once, and 0.7.284 answered 42 s later, so each door says 42 s.
 */
import { describe, expect, test } from "bun:test";
import type { Ctx as HttpCtx } from "../src/http/context.ts";
import { tool as keeperTool } from "../src/http/mcp/tools/release_keeper.ts";
import { tick } from "../src/keeper/keeper.ts";
import type { LandedRelease } from "../src/keeper/landed.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { keeperScreen } from "../src/tui/screens/keeper.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { quietLogs } from "./helpers/globals.ts";
import { B, keeperForge } from "./helpers/keeper.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

/** B landed through pull 7 at the clock's noon, was cut, and answered as 0.7.284 42 s after it merged. */
async function liveForge() {
  const f = await keeperForge();
  const merged = new Date(f.world.now).toISOString();
  f.app.db
    .query(`INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at) VALUES (?1, ?2, 7, 1, 'preflight ok', ?3)`)
    .run(B, f.repo.id, merged);
  expect(await tick(f.ports)).toContain("cut 0.7.284");
  f.world.now = Date.parse(merged) + 42_000;
  f.world.live = "0.7.284";
  await tick(f.ports);
  return f;
}

describe("landed to live at every door", () => {
  test("MCP release_keeper gives each release its short commit and landed-to-live seconds", async () => {
    const f = await liveForge();
    const read = await keeperTool.run({ app: f.app } as unknown as HttpCtx, f.user, {});
    if (!read.ok) throw new Error("release_keeper refused an admin");
    const [first] = (read.value as { releases: LandedRelease[] }).releases;
    expect(first).toMatchObject({ version: "0.7.284", commit: "bbbbbbb", landedToLiveSeconds: 42 });
  });

  test("the terminal's Release keeper shows the short commit and landed to live", async () => {
    const f = await liveForge();
    const terminal = headlessTerminal(200, 20);
    const { app: tui, session } = createForgeApp(f.app, identity(f.user), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(keeperScreen(session, tui.ctx));
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("bbbbbbb");
    expect(text).toContain("landed to live 42 s");
  });

  test("/releases puts the eight-column table in the named scroller, with the figure in it", async () => {
    const f = await liveForge();
    const card = String(keeperPanel(f.app.db));
    expect(card).toMatch(/<div class="table-scroll" role="region" tabindex="0" aria-label="Keeper releases"><table class="table" data-sticky-lead>/);
    expect(card).toContain('<span class="small muted">bbbbbbb</span>');
    expect(card).toContain("<td>42 s</td>");
  });
});
