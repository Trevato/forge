/**
 * The release keeper in the terminal (#7557): the palette offers it to whoever
 * may read /releases, and the screen shows the card's read — what holds the
 * next cut, then each release with its stage, known-good version and numbers.
 */
import { describe, expect, test } from "bun:test";
import { tick } from "../src/keeper/keeper.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { holdLine, keeperScreen, readKeeper } from "../src/tui/screens/keeper.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { keeperForge } from "./helpers/keeper.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

/** A forge whose 0.7.284 failed its verify and was rolled back to 0.7.283. */
async function heldForge() {
  const f = await keeperForge();
  await tick(f.ports);
  f.world.live = "0.7.284";
  f.world.healthz = (n) => (n >= 5 ? { status: 503, ms: 2 } : { status: 200, ms: 2 });
  await tick(f.ports);
  return f;
}

describe("the release keeper screen", () => {
  test("the palette offers it to an admin, not to a guest", async () => {
    const f = await keeperForge();
    const offered = (user?: User) => forgeCommands(new Session(f.app, identity(user)))({} as Ctx).some((c) => c.id === "keeper");
    expect(offered(f.user)).toBe(true);
    expect(offered(undefined)).toBe(false);
    expect(readKeeper(new Session(f.app, identity(undefined)))).toBeUndefined();
  });

  test("it shows what holds the next cut and the rolled-back release with its numbers", async () => {
    const f = await heldForge();
    const terminal = headlessTerminal(160, 20);
    const { app: tui, session } = createForgeApp(f.app, identity(f.user), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(keeperScreen(session, tui.ctx));
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("0.7.284 failed its verify");
    expect(text.replace(/\s+/g, " ")).toContain(`a pull saying "release hold 1" to land`);
    expect(text).toContain("rolled back");
    expect(text).toContain("known good 0.7.283");
    expect(text).toMatch(/8 probes/);
  });

  test("with nothing cut, it says nothing holds the next cut and that no releases are kept yet", async () => {
    const f = await keeperForge();
    const read = readKeeper(new Session(f.app, identity(f.user)));
    expect(read).toEqual({ blocked: "Nothing holds the next cut.", heartbeat: "The release tick has never reported a heartbeat.", releases: [] });
  });

  test("`now: reason` asks for a cut at the next tick through the hold prompt, and the card says so", async () => {
    const f = await keeperForge();
    const session = new Session(f.app, identity(f.user));
    expect(holdLine(session, "now: hotfix for the login page")).toEqual({ ok: true, says: "Release asked for now: hotfix for the login page" });
    expect(readKeeper(session)?.asked).toContain("hotfix for the login page");
    expect(holdLine(session, "now: ").ok).toBe(false);
  });
});
