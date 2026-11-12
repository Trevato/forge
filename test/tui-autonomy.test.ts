/**
 * A repository's autonomy in the terminal (issue #8132, pull #8137): an admin who is a person
 * picks any mode outright, and changes ceiling and slots through `updateRepoSettings`; out-of-range
 * input is refused with the page's sentence; an agent who administers is let
 * in as the page's API lets one; a reader and a writer who is not an admin get
 * no palette entry and see no value.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { AUTONOMY_BOUNDS, AUTONOMY_SAID, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserById, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { FLASH_COOKIE } from "../src/web/flash.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("autonomy in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let ada: User; // site admin, owns the repository
  let erin: User; // administers it through a team
  let dave: User; // writes
  let bot: User; // an agent, an admin
  let repo: Repo;

  const saved = () => getRepoById(forge.db, repo.id)!;

  function boot(user: User | undefined) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => {
      const ctrl = k.startsWith("ctrl+");
      app.dispatch({ type: "key", key: ctrl ? k.slice(5) : k, ctrl, alt: false, shift: false });
    };
    const press = async (...keys: string[]) => {
      for (const k of keys) key(k);
      await settleApp(app);
    };
    const type = async (text: string) => {
      for (const ch of text) key(ch);
      await settleApp(app);
    };
    const open = async () => {
      await settleApp(app);
      await press("ctrl+k");
      await type("Open a repository");
      await press("enter");
      await type("acme/arm");
      await press("enter");
      await press("ctrl+k");
      await type("Autonomy");
      await press("enter");
    };
    return { app, text: () => app.screen.toText(), press, type, open, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-autonomy-"));
    forge = createApp({ dataDir, port: 0 });
    const make = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    dave = await make("dave", false);
    erin = await make("erin", false);
    const robot = await make("robo", false);
    promote(forge.db, dave, erin);
    forge.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE id = ?").run(robot.id);
    bot = getUserById(forge.db, robot.id)!;
    expect(bot.kind).toBe("agent");
    const org = createOrg(forge.db, "acme", ada.id);
    if (!org.ok) throw new Error("org");
    const writers = createTeam(forge.db, org.value.id, "writers", "write");
    if (!writers.ok) throw new Error("team");
    addTeamMember(forge.db, writers.value, dave.id);
    const stewards = createTeam(forge.db, org.value.id, "stewards", "admin");
    if (!stewards.ok) throw new Error("team");
    addTeamMember(forge.db, stewards.value, erin.id);
    const made = await createRepo(forge, ada, { name: "arm", owner: "acme", visibility: "public", description: "" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    repo = made.value;
  }, 60_000);

  afterAll(async () => {
    forge?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  // The confirm opens on Cancel; each `left` moves one mode back: Autonomous, Assisted, Off.
  const pick = { autonomous: ["left"], assisted: ["left", "left"], off: ["left", "left", "left"] } as const;

  test("an admin picks the mode after a confirm that names the modes and the ceiling; Cancel is the default", async () => {
    const h = boot(erin);
    await h.open();
    expect(h.text()).toContain("Autonomy is off.");
    await h.press("m");
    expect(h.text()).toContain("Set autonomy (now off)");
    expect(h.text()).toContain(AUTONOMY_SAID.autonomous);
    expect(h.text()).toContain(`The ceiling that applies is $${saved().autonomyCeilingUsd} a day.`);
    await h.press("enter");
    expect(saved().autonomy).toBe("off");
    await h.press("m", "esc");
    expect(saved().autonomy).toBe("off");
    await h.press("m", ...pick.assisted, "enter");
    expect(saved().autonomy).toBe("assisted");
    expect(saved().autonomyBy).toBe(erin.id);
    h.stop();
  });

  for (const from of ["autonomous", "assisted"] as const) {
    test(`an admin goes from ${from} straight to off, with no save in between`, async () => {
      forge.db.query("UPDATE repo SET autonomy = ?, autonomy_by = ? WHERE id = ?").run(from, erin.id, repo.id);
      const h = boot(erin);
      await h.open();
      await h.press("m");
      expect(h.text()).toContain(`Set autonomy (now ${from})`);
      await h.press(...pick.off);
      expect(saved().autonomy).toBe(from);
      await h.press("enter");
      expect(saved().autonomy).toBe("off");
      expect(saved().autonomyBy).toBeNull();
      expect(h.text()).toContain(AUTONOMY_SAID.off);
      h.stop();
    });
  }

  test("the terminal's toast for each mode is the settings page's flash", async () => {
    const servers = await serve(forge);
    try {
      const cookie = (
        (
          await fetch(`${servers.url}/signin`, {
            method: "POST",
            body: new URLSearchParams({ username: "erin", password: "a-good-passphrase" }),
            redirect: "manual",
          })
        ).headers.get("set-cookie") ?? ""
      ).split(";")[0]!;
      const flashOf = async (mode: string): Promise<string> => {
        const res = await fetch(`${servers.url}/acme/arm/settings/autonomy`, {
          method: "POST",
          headers: { cookie, origin: servers.url },
          body: new URLSearchParams({ autonomy: mode, ceiling: "5", slots: "1" }),
          redirect: "manual",
        });
        const set = res.headers.getSetCookie().find((c) => c.startsWith(`${FLASH_COOKIE}=`)) ?? "";
        return JSON.parse(decodeURIComponent(set.slice(FLASH_COOKIE.length + 1).split(";")[0]!)).message;
      };
      // Each mode is reached from a different one, so every pick saves.
      for (const [mode, before] of [["off", "assisted"], ["assisted", "off"], ["autonomous", "off"]] as const) {
        const page = await flashOf(mode);
        expect(page).toBe(AUTONOMY_SAID[mode]);
        await flashOf(before);
        const h = boot(erin);
        await h.open();
        await h.press("m", ...pick[mode], "enter");
        expect(saved().autonomy).toBe(mode);
        expect(h.text()).toContain(page);
        h.stop();
      }
    } finally {
      servers.stop();
    }
  });

  test("the ceiling and the slots are saved", async () => {
    const h = boot(ada);
    await h.open();
    await h.press("c");
    for (let i = 0; i < 10; i++) await h.press("backspace");
    await h.type("12.5");
    await h.press("enter");
    expect(saved().autonomyCeilingUsd).toBe(12.5);
    await h.press("s");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.type("3");
    await h.press("enter");
    expect(saved().autonomySlots).toBe(3);
    expect(h.text()).toContain("$12.5");
    h.stop();
  });

  test("p, s and r set the planner, builder and reviewer; 0 pauses and the audit line says from what to what", async () => {
    const h = boot(ada);
    await h.open();
    expect(h.text()).toContain("Planner");
    expect(h.text()).toContain("Reviewer");
    for (const [key, value] of [["p", "0"], ["s", "0"], ["r", "2"]] as const) {
      await h.press(key);
      for (let i = 0; i < 4; i++) await h.press("backspace");
      await h.type(value);
      await h.press("enter");
    }
    expect(saved()).toMatchObject({ plannerSlots: 0, autonomySlots: 0, reviewerSlots: 2 });
    expect(h.text()).toContain("Paused");
    await h.press("p");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.type("2");
    await h.press("enter");
    expect(saved().plannerSlots).toBe(0);
    expect(h.text()).toContain(AUTONOMY_BOUNDS);
    h.stop();
  });

  test("a ceiling or slots out of range are refused with the page's sentence and nothing is saved", async () => {
    const h = boot(ada);
    await h.open();
    const before = saved();
    for (const bad of ["-1", "abc", ""]) {
      await h.press("c");
      for (let i = 0; i < 10; i++) await h.press("backspace");
      await h.type(bad);
      await h.press("enter");
      expect(h.text()).toContain(AUTONOMY_BOUNDS);
      expect(saved().autonomyCeilingUsd).toBe(before.autonomyCeilingUsd);
    }
    for (const bad of ["9", "2.5", "x", "-1"]) {
      await h.press("s");
      for (let i = 0; i < 4; i++) await h.press("backspace");
      await h.type(bad);
      await h.press("enter");
      expect(h.text()).toContain(AUTONOMY_BOUNDS);
      expect(saved().autonomySlots).toBe(before.autonomySlots);
    }
    h.stop();
  });

  test("o sets the polish share through updateRepoSettings, refuses what the page refuses, and the week screen shows it live", async () => {
    const h = boot(ada);
    await h.open();
    expect(h.text()).toContain("Polish   10% of the week's spend");
    await h.press("o");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.type("25");
    await h.press("enter");
    expect(saved().polishShare).toBe(25);
    expect(h.text()).toContain("Polish   25% of the week's spend");
    for (const bad of ["51", "-1", "2.5", "x", ""]) {
      await h.press("o");
      for (let i = 0; i < 4; i++) await h.press("backspace");
      await h.type(bad);
      await h.press("enter");
      expect(h.text()).toContain("Polish share is a whole number of percent, 0 to 50.");
      expect(saved().polishShare).toBe(25);
    }
    h.stop();

    const w = boot(ada);
    await w.open();
    await w.press("esc");
    await w.press("ctrl+k");
    await w.type("The week");
    await w.press("enter");
    await w.type("acme/arm");
    await w.press("enter");
    expect(w.text()).toContain("polish 0.0% of 25% this week ($0.00 of $0.00)");
    // A change made anywhere else reaches the open screen without a key.
    expect((await updateRepoSettings(forge, ada, saved(), { polishShare: 30 })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    await settleApp(w.app);
    expect(w.text()).toContain("of 30% this week");
    w.stop();
  });

  for (const [who, get] of [
    ["a writer who is not an admin", () => dave],
    ["a reader", () => undefined],
  ] as const) {
    test(`${who} is offered no Autonomy entry and sees no value`, async () => {
      const before = saved();
      const h = boot(get());
      await h.open();
      expect(h.text()).not.toContain("Builder");
      expect(h.text()).not.toContain("Ceiling");
      expect(h.text()).not.toContain("Mode ");
      await h.press("m", "left", "enter", "c", "s");
      expect(h.text()).not.toContain("Set autonomy");
      const after = saved();
      expect(after.autonomy).toBe(before.autonomy);
      expect(after.autonomyCeilingUsd).toBe(before.autonomyCeilingUsd);
      expect(after.autonomySlots).toBe(before.autonomySlots);
      h.stop();
    });
  }

  test("an agent who administers the repository changes it, as the page's API lets it", async () => {
    const h = boot(bot);
    await h.open();
    expect(h.text()).toContain("Builder");
    await h.press("s");
    for (let i = 0; i < 4; i++) await h.press("backspace");
    await h.type("2");
    await h.press("enter");
    expect(saved().autonomySlots).toBe(2);
    h.stop();
  });
});
