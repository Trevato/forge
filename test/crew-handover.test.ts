/**
 * Settings → Crew and the terminal's crew screen say what the crew handed
 * on: issues parked twice (the planner's) and the last restore drill — to a
 * forge admin only, each only when it has something to say.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser } from "../src/core/users.ts";
import { recordDrill } from "../src/snapshot/drills.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { engine, tick, type Engine } from "./helpers/parks-engine.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const evil = `<img src=x onerror=alert(1)>`;

describe("what the crew handed on", () => {
  let e: Engine;
  let base: string;
  const cookies: Record<string, string> = {};
  const signIn = async (name: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username: name, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const crewPage = async (who: string): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${base}/settings/crew`, { headers: { cookie: cookies[who]! } });
    return { status: res.status, text: await res.text() };
  };
  const terminal = async (username: string): Promise<string> => {
    const user = (await import("../src/core/users.ts")).getUserByName(e.app.db, username)!;
    const { app } = createForgeApp(
      e.app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal: headlessTerminal(140, 32), exitHooks: false },
    );
    app.start();
    const key = (k: string, ctrl = false) =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    key("k", true);
    for (const ch of "Crew hand-overs") key(ch);
    await settleApp(app);
    key("enter");
    await settleApp(app);
    const text = app.screen.toText();
    app.stop();
    return text;
  };

  beforeAll(async () => {
    e = await engine("forge-handover-");
    base = e.servers.url;
    const made = await createUser(e.app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: false,
    });
    if (!made.ok) throw new Error(made.error);
    cookies.alice = await signIn("alice");
    cookies.bob = await signIn("bob");
  });
  afterAll(() => e.close());

  test("empty: neither card is drawn, and no drill copy", async () => {
    const { status, text } = await crewPage("alice");
    expect(status).toBe(200);
    expect(text).not.toContain("Handed to the planner");
    expect(text).not.toContain("Restore drill");
    expect(text).not.toContain(`data-drill`);
    expect(await terminal("alice")).not.toContain("Restore drill:");
  });

  test("an admin sees both; reasons are escaped", async () => {
    const work = e.issue("Scene graph");
    expect(e.ended(work, `no changes pushed: ${evil}`)).toBe(true);
    await tick();
    expect(e.ended(work, "nothing to propose")).toBe(true);
    await tick();
    recordDrill(e.app.db, {
      at: new Date().toISOString(),
      snapshotId: "s1",
      ms: 10,
      counts: { users: 1, repositories: 1, issues: 1, pulls: 0, apps: 0 },
      health: "ok",
      verdict: "red",
      failedStep: "open",
      phases: [],
      budgetMs: 0,
      reason: "x",
    });
    const { text } = await crewPage("alice");
    expect(text).toContain("Handed to the planner");
    expect(text).toContain("Scene graph");
    expect(text).toContain(`/alice/engine/issues/${work.number}`);
    expect(text).toContain("Restore drill");
    expect(text).toContain(`data-drill="red"`);
    expect(text).not.toContain(evil);
    expect(text).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const tui = await terminal("alice");
    expect(tui).toContain("Handed to the planner: alice/engine#");
    expect(tui).toContain("Restore drill: failed");
  });

  test("a non-admin gets neither", async () => {
    const { status, text } = await crewPage("bob");
    expect(status).toBe(403);
    expect(text).not.toContain("Handed to the planner");
    expect(text).not.toContain("Restore drill");
    expect(await terminal("bob")).not.toContain("Handed to the planner: ");
  });

  test("a split issue leaves the card", async () => {
    const { setIssueState } = await import("../src/actions/issues.ts");
    const work = e.issue("Another");
    e.ended(work, "a");
    await tick();
    e.ended(work, "b");
    await tick();
    expect((await crewPage("alice")).text).toContain("Another");
    setIssueState(e.app, e.alice, e.fresh(), work, "closed");
    expect((await crewPage("alice")).text).not.toContain("Another");
  });
});
