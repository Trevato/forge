/**
 * Crew teams in the terminal (#2679): an admin who is not an agent lists the
 * teams, sets a dial, a charter and the members through `changeTeam` (so the
 * same refusals apply and the change is kept and put on the bus); anyone else
 * has no command and, driving the screen directly, can neither read nor write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve } from "../src/http/server.ts";
import { teamChanges } from "../src/actions/teams.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { getTeam } from "../src/core/teams.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { teamsScreen } from "../src/tui/screens/teams.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("teams in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const { app } = createForgeApp(
      forge,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(app);
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-teams-"));
    forge = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob", "carol", "bot1"]) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "bot1") createAgentRow(forge.db, { userId: made.value.id, model: "opus" });
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Crew teams");
    await h.press("enter");
  };

  test("an admin sets the dial, charter and members; it is kept with who and emitted", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("Design");
    expect(h.text()).toContain("Platform");

    await h.press("enter");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.type("30");
    await h.press("enter");
    expect(getTeam(forge.db, "design")!.dial).toBe(30);
    expect(h.text()).toContain("Design saved at 30%.");

    await h.press("m");
    await h.type("bot1");
    await h.press("enter");
    expect(getTeam(forge.db, "design")!.members).toHaveLength(1);
    expect(h.text()).toContain("bot1");

    await h.press("c");
    await h.type(" Also owns icons.");
    await h.press("enter");
    expect(getTeam(forge.db, "design")!.charter).toContain("Also owns icons.");

    const kept = teamChanges(forge).find((c) => c.from.startsWith("0% · 0 members"));
    expect(kept).toMatchObject({ slug: "design", actorName: "alice" });
    expect(kept!.to).toStartWith("30% · 0 members");
    expect(listEvents(forge.db, { kind: "team.changed" }).length).toBe(3);
    h.stop();
  });

  test("a save made in the terminal arrives on an open /settings/teams stream", async () => {
    const servers = await serve(forge);
    const alice = getUserByName(forge.db, "alice")!;
    const bob = getUserByName(forge.db, "bob")!;
    const cookie = (id: string) => `forge_session=${createSession(forge.db, id).token}`;
    const denied = await fetch(`${servers.url}/settings/teams/stream`, { headers: { cookie: cookie(bob.id) } });
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
    const res = await fetch(`${servers.url}/settings/teams/stream`, { headers: { cookie: cookie(alice.id) } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const h = boot("alice");
    await open(h);
    await h.press("j", "j", "enter");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.type("7");
    await h.press("enter");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes("7%") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    if (!text.includes("7%")) throw new Error(`never came: still waiting while !text.includes("7%")`);
    await reader.cancel();
    h.stop();
    servers.stop();
    expect(text).toContain("event: teams");
    expect(text).toContain("teams-total");
    expect(text).toContain("security: ");
  });

  test("a refusal says the shared sentence and changes nothing", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("j", "enter");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.type("80");
    await h.press("enter");
    expect(h.text()).toContain("may not pass 100%");
    expect(getTeam(forge.db, "data-science")!.dial).toBe(0);
    h.stop();
  });

  test("a non-admin and an admin agent have no command", async () => {
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Crew teams");
      expect(h.text()).not.toContain("charter, dial and members");
      h.stop();
    }
  });

  test("a non-admin driving the screen reads nothing and writes nothing", () => {
    for (const who of ["bob", "carol"]) {
      const user = getUserByName(forge.db, who)!;
      const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
      const pushed: unknown[] = [];
      const screen = teamsScreen(session, { push: (s: unknown) => pushed.push(s), invalidate() {} } as never);
      for (const k of ["enter", "c", "m"])
        screen.key?.({ type: "key", key: k, ctrl: false, alt: false, shift: false } as never);
      expect(pushed).toEqual([]);
    }
  });
});
