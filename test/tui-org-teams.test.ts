/**
 * Organization teams in the terminal (#7997): an org admin sees every team of
 * the organization, a member only the teams they are in (`listTeamsVisibleTo`,
 * the Teams page's rule); Enter lists the team's members; a person in no
 * organization is not offered the entry. An org admin adds a person with `a`
 * and removes the member under the cursor with `d` after a y/n (#8125); a
 * member is offered neither.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam, listTeamMembers, listTeams } from "../src/core/orgs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("organization teams in the terminal", () => {
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
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
      },
      ctrl: async (k: string) => {
        key(k, true);
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Organization teams");
    await h.press("enter");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-org-teams-"));
    forge = createApp({ dataDir, port: 0 });
    for (const username of ["rooty", "olive", "mark", "dana", "finn", "erin"]) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "rooty",
        ...(username === "mark" ? { displayName: "Mark Member" } : {}),
      });
      if (!made.ok) throw new Error(made.error);
    }
    const id = (n: string) => getUserByName(forge.db, n)!.id;
    const org = createOrg(forge.db, "acme", id("olive"));
    if (!org.ok) throw new Error(org.error);
    const writers = createTeam(forge.db, org.value.id, "Writers", "write");
    const readers = createTeam(forge.db, org.value.id, "Readers", "read");
    if (!writers.ok || !readers.ok) throw new Error("team");
    addTeamMember(forge.db, writers.value, id("mark"));
    addTeamMember(forge.db, readers.value, id("dana"));
    addTeamMember(forge.db, readers.value, id("finn"));
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an org admin sees every team with its member count", async () => {
    const h = boot("olive");
    await open(h);
    const text = h.text();
    expect(text).toContain("Organization teams");
    expect(text).toContain("Owners");
    expect(text).toContain("Writers");
    expect(text).toContain("Readers");
    expect(text).toContain("@acme");
    const row = (team: string) => text.split("\n").find((l) => l.includes(team)) ?? "";
    expect(row("Writers")).toContain("1 member · write");
    expect(row("Readers")).toContain("2 members · read");
    h.stop();
  });

  test("a member sees only the teams they are in", async () => {
    const h = boot("mark");
    await open(h);
    const text = h.text();
    expect(text.split("\n").find((l) => l.includes("Writers")) ?? "").toContain("1 member · write");
    expect(text).not.toContain("Readers");
    expect(text).not.toContain("Owners");
    h.stop();
  });

  test("Enter lists the team's members, and esc goes back", async () => {
    const h = boot("mark");
    await open(h);
    await h.press("enter");
    let text = h.text();
    expect(text).toContain("acme / Writers");
    expect(text).toContain("@mark");
    expect(text).toContain("Mark Member");
    expect(text).not.toContain("@dana");
    expect(text).not.toContain("@olive");
    await h.press("esc");
    text = h.text();
    expect(text).not.toContain("acme / Writers");
    expect(text).toContain("Organization teams");
    h.stop();
  });

  test("a person in no organization is not offered the entry", async () => {
    const h = boot("erin");
    await h.ctrl("k");
    await h.type("Organization teams");
    expect(h.text()).not.toContain("who is in each team of your organizations");
    h.stop();
    const m = boot("mark");
    await m.ctrl("k");
    await m.type("Organization teams");
    expect(m.text()).toContain("who is in each team of your organizations");
    m.stop();
  });
  /** Open the teams screen as `who` and step into the team named `team`. */
  const openTeam = async (who: string, team: string) => {
    const h = boot(who);
    await open(h);
    const rows = h.text().split("\n");
    const teams = rows.filter((l) => /(Owners|Writers|Readers)/.test(l) && l.includes("@acme"));
    const at = teams.findIndex((l) => l.includes(team));
    for (let i = 0; i < at; i++) await h.press("j");
    await h.press("enter");
    expect(h.text()).toContain(`acme / ${team}`);
    return h;
  };
  const members = (team: string) => {
    const org = getUserByName(forge.db, "acme")!;
    const t = listTeams(forge.db, org.id).find((x) => x.name === team)!;
    return listTeamMembers(forge.db, t.id).map((u) => u.username).sort();
  };

  test("an org admin adds a person with a, and the list and count redraw", async () => {
    const h = await openTeam("olive", "Writers");
    expect(h.text()).toContain("a  add");
    await h.press("a");
    await h.type("nobody");
    await h.press("enter");
    expect(h.text()).toContain("No account called nobody.");
    expect(members("Writers")).toEqual(["mark"]);
    for (let i = 0; i < 6; i++) await h.press("backspace");
    await h.type("erin");
    await h.press("enter");
    expect(members("Writers")).toEqual(["erin", "mark"]);
    expect(h.text()).toContain("@erin");
    await h.press("esc");
    expect(h.text().split("\n").find((l) => l.includes("Writers")) ?? "").toContain("2 members · write");
    h.stop();
  });

  test("d asks before removing; anything but y leaves the team as it was", async () => {
    const h = await openTeam("olive", "Readers");
    await h.press("d");
    expect(h.text()).toContain("remove @dana from Readers? y/n");
    await h.press("n");
    expect(members("Readers")).toEqual(["dana", "finn"]);
    await h.press("d");
    await h.press("y");
    expect(members("Readers")).toEqual(["finn"]);
    expect(h.text()).not.toContain("@dana");
    await h.press("esc");
    expect(h.text().split("\n").find((l) => l.includes("Readers")) ?? "").toContain("1 member · read");
    h.stop();
  });

  test("a member who is not an org admin is offered neither a nor d", async () => {
    const h = await openTeam("mark", "Writers");
    const before = members("Writers");
    expect(h.text()).not.toContain("a  add");
    expect(h.text()).not.toContain("d  remove");
    await h.press("d");
    expect(h.text()).not.toContain("y/n");
    await h.press("y");
    await h.press("a");
    expect(h.text()).not.toContain("Username");
    expect(members("Writers")).toEqual(before);
    h.stop();
  });
});
