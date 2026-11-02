// An owner's hold from each door — the /releases card, the terminal screen and MCP — runs the one function
// in src/keeper/hold.ts; a refusal (an agent, a non-admin, a cross-origin post) writes no hold and no event (#7557).
import { describe, expect, test } from "bun:test";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { holdAs, liftAs, listHolds, standingHolds } from "../src/keeper/hold.ts";
import { serve } from "../src/http/server.ts";
import { createForgeApp, Session } from "../src/tui/forge.ts";
import { holdLine, keeperScreen } from "../src/tui/screens/keeper.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { keeperForge } from "./helpers/keeper.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });
const heldEvents = (f: Awaited<ReturnType<typeof keeperForge>>) => f.events("release.held").length + f.events("release.hold_lifted").length;

describe("the shared hold functions", () => {
  test("an agent and a non-admin are refused, and a refusal writes no hold and no event", async () => {
    const f = await keeperForge();
    const bob = await createUser(f.app.db, { username: "bob", email: "b@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!bob.ok) throw new Error("user");
    const owner = holdAs(f.app, f.user, "freeze");
    expect(owner.ok).toBe(true);
    const before = heldEvents(f);
    for (const who of [{ ...f.user, kind: "agent" as const }, bob.value, undefined]) {
      expect(holdAs(f.app, who, "stop").ok).toBe(false);
      expect(liftAs(f.app, who, 1).ok).toBe(false);
    }
    expect(listHolds(f.app.db)).toHaveLength(1);
    expect(standingHolds(f.app.db)).toHaveLength(1);
    expect(heldEvents(f)).toBe(before);
  });

  test("control characters are stripped and an empty reason is refused", async () => {
    const f = await keeperForge();
    const h = holdAs(f.app, f.user, "a\u0007b\nc");
    expect(h.ok && h.value.reason).toBe("a b c");
    expect(holdAs(f.app, f.user, "  ").ok).toBe(false);
  });
});

describe("the /releases card", () => {
  test("offers the form to whoever may roll back, and posts through the shared function", async () => {
    const f = await keeperForge();
    const servers = await serve(f.app);
    try {
      expect(String(keeperPanel(f.app.db, false))).not.toContain("/releases/hold");
      expect(String(keeperPanel(f.app.db, true))).toContain('action="/releases/hold"');
      const cookie = `forge_session=${createSession(f.app.db, f.user.id).token}`;
      const post = (path: string, fields: Record<string, string>, origin = servers.url) =>
        fetch(`${servers.url}${path}`, { method: "POST", headers: { cookie, origin }, body: new URLSearchParams(fields), redirect: "manual" });
      const cross = await post("/releases/hold", { reason: "x" }, "https://evil.test");
      expect(cross.status).toBe(403);
      expect(standingHolds(f.app.db)).toHaveLength(0);
      const res = await post("/releases/hold", { reason: "freeze for the demo" });
      expect(res.status).toBe(303);
      expect(standingHolds(f.app.db).map((h) => [h.kind, h.reason])).toEqual([["owner", "freeze for the demo"]]);
      expect(String(keeperPanel(f.app.db, true))).toContain("/releases/hold/1/lift");
      expect((await post("/releases/hold/1/lift", {})).status).toBe(303);
      expect(standingHolds(f.app.db)).toHaveLength(0);
    } finally {
      servers.stop();
    }
  });

  test("a guest and a member who may not administer are refused and nothing is written", async () => {
    const f = await keeperForge();
    const servers = await serve(f.app);
    try {
      const bob = await createUser(f.app.db, { username: "bob", email: "b@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
      if (!bob.ok) throw new Error("user");
      const cookie = `forge_session=${createSession(f.app.db, bob.value.id).token}`;
      for (const headers of [{ origin: servers.url }, { cookie, origin: servers.url }]) {
        const res = await fetch(`${servers.url}/releases/hold`, { method: "POST", headers, body: new URLSearchParams({ reason: "x" }), redirect: "manual" });
        expect(res.status).not.toBe(303);
      }
      expect(listHolds(f.app.db)).toHaveLength(0);
      expect(heldEvents(f)).toBe(0);
    } finally {
      servers.stop();
    }
  });
});

describe("the terminal screen", () => {
  test("h holds with a reason and `lift N` lifts it", async () => {
    const f = await keeperForge();
    const session = new Session(f.app, identity(f.user));
    expect(holdLine(session, "freeze").ok).toBe(true);
    expect(standingHolds(f.app.db)).toHaveLength(1);
    expect(holdLine(session, "lift 1").ok).toBe(true);
    expect(standingHolds(f.app.db)).toHaveLength(0);
    expect(holdLine(new Session(f.app, identity(undefined)), "freeze").ok).toBe(false);
    expect(listHolds(f.app.db)).toHaveLength(1);
  });

  test("the key is on the screen and opens the prompt", async () => {
    const f = await keeperForge();
    const terminal = headlessTerminal(120, 20);
    const { app: tui, session } = createForgeApp(f.app, identity(f.user), { terminal, exitHooks: false });
    tui.start();
    const screen = keeperScreen(session, tui.ctx);
    tui.ctx.push(screen);
    await settleApp(tui);
    screen.key!({ key: "h" } as never);
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("Hold releases");
  });
});
