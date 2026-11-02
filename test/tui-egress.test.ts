/**
 * An app's private destinations in the terminal (#3618): a site admin lists,
 * grants and revokes them through the same actions as the settings page; a
 * writer is offered neither the list nor the keys, and nothing is written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { egressView } from "../src/actions/egress_grants.ts";
import { listEgressGrants } from "../src/core/egress_grants.ts";
import { listEvents } from "../src/core/events.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { egressScreen } from "../src/tui/screens/egress.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp, settlePalette, settleUntil } from "./helpers/tui.ts";

quietLogs();

const ARM = "100.89.95.68:8101";
const CAMERA = "100.89.95.68:8102";

describe("private destinations in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let ada: User; // site admin
  let erin: User; // administers the repository through a team, is no site admin
  let dave: User; // writes to the repository, is no site admin
  let repo: Repo;

  const grants = () => listEgressGrants(forge.db, repo.id).map((g) => g.destination);
  const changes = () =>
    listEvents(forge.db, { repoId: repo.id }).filter((e) => e.kind.startsWith("app.egress."));

  function boot(user: User) {
    // Wide enough that the About card's hint line reaches `e  egress`.
    const terminal = headlessTerminal(200, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        const ctrl = key.startsWith("ctrl+");
        app.dispatch({ type: "key", key: ctrl ? key.slice(5) : key, ctrl, alt: false, shift: false });
      }
      await settleApp(app);
    };
    const toAbout = async () => {
      await settleApp(app);
      await press("ctrl+k");
      for (const ch of "Open a repository")
        app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settlePalette(app);
      await press("enter");
      for (const ch of "acme/arm")
        app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settlePalette(app);
      await press("enter");
      await press("I");
      // "About" is in the breadcrumb at once; the footer's `v  events` key exists only once the repository has loaded.
      await settleUntil(app, "v  events");
    };
    return { text: () => app.screen.toText(), press, toAbout, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-egress-"));
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
    promote(forge.db, dave, erin);
    const org = createOrg(forge.db, "acme", ada.id);
    if (!org.ok) throw new Error("org");
    const team = createTeam(forge.db, org.value.id, "writers", "write");
    if (!team.ok) throw new Error("team");
    addTeamMember(forge.db, team.value, dave.id);
    const stewards = createTeam(forge.db, org.value.id, "stewards", "admin");
    if (!stewards.ok) throw new Error("team");
    addTeamMember(forge.db, stewards.value, erin.id);
    const made = await createRepo(forge, ada, { name: "arm", owner: "acme", visibility: "public", description: "" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    repo = made.value;
    const committed = await commitToBranch(forge, ada, repo, {
      message: "Ask for the arm",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({ app: { run: "bun run src/server.ts" }, egress: [ARM, CAMERA] }),
        },
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  }, 60_000);

  afterAll(async () => {
    forge?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer is offered neither the list nor the keys, and a press changes nothing", async () => {
    const h = boot(dave);
    await h.toAbout();
    expect(h.text()).not.toContain("e  egress");
    await h.press("e", "g", "x");
    expect(h.text()).not.toContain("Private egress");
    expect(h.text()).not.toContain("asked for, not granted");
    expect(grants()).toEqual([]);
    h.stop();
  });

  test("a site admin lists, grants and revokes through the actions", async () => {
    const h = boot(ada);
    await h.toAbout();
    expect(h.text()).toContain("e  egress");
    await h.press("e");
    expect(h.text()).toContain("Private egress");
    expect(h.text()).toContain(ARM);
    expect(h.text()).toContain(CAMERA);
    expect(h.text()).toContain("asked for, not granted");
    await h.press("g");
    expect(h.text()).toContain(`Let acme/arm reach ${ARM}?`);
    expect(grants()).toEqual([]);
    await h.press("y");
    expect(grants()).toEqual([ARM]);
    expect(h.text()).toContain(`${ARM} is granted.`);
    // Already granted: `g` asks nothing and grants nothing again.
    await h.press("g");
    expect(h.text()).not.toContain(`Let acme/arm reach ${ARM}?`);
    expect(h.text()).toContain("granted by ada");
    expect(changes().map((e) => e.kind)).toEqual(["app.egress.granted"]);
    await h.press("x");
    expect(h.text()).toContain(`Stop acme/arm reaching ${ARM}?`);
    expect(grants()).toEqual([ARM]);
    await h.press("y");
    expect(grants()).toEqual([]);
    expect(changes().map((e) => e.kind).sort()).toEqual(["app.egress.granted", "app.egress.revoked"]);
    h.stop();
  });

  test("a site admin who presses x then n or esc revokes nothing", async () => {
    const h = boot(ada);
    await h.toAbout();
    await h.press("e");
    await h.press("g");
    await h.press("y");
    expect(grants()).toEqual([ARM]);
    const before = changes().length;
    await h.press("x");
    expect(h.text()).toContain(`Stop acme/arm reaching ${ARM}?`);
    expect(h.text()).toContain("refused until g grants it again.");
    await h.press("n");
    expect(h.text()).not.toContain(`Stop acme/arm reaching ${ARM}?`);
    await h.press("x");
    await h.press("esc");
    expect(h.text()).not.toContain(`Stop acme/arm reaching ${ARM}?`);
    expect(grants()).toEqual([ARM]);
    expect(changes().length).toBe(before);
    await h.press("x");
    await h.press("y");
    expect(grants()).toEqual([]);
    h.stop();
  });

  test("a site admin who presses g then n grants nothing", async () => {
    const before = changes().length;
    const h = boot(ada);
    await h.toAbout();
    await h.press("e");
    await h.press("g");
    expect(h.text()).toContain(`Let acme/arm reach ${ARM}?`);
    expect(h.text()).toContain("The app's outbound traffic to it is allowed until you revoke it with x.");
    await h.press("n");
    expect(h.text()).not.toContain(`Let acme/arm reach ${ARM}?`);
    expect(grants()).toEqual([]);
    expect(changes().length).toBe(before);
    const view = await egressView(forge, ada, repo);
    expect(view.ok && view.value.rows.find((r) => r.destination === ARM)?.granted).toBe(false);
    await h.press("g");
    expect(h.text()).toContain(`Let acme/arm reach ${ARM}?`);
    await h.press("esc");
    expect(h.text()).not.toContain(`Let acme/arm reach ${ARM}?`);
    expect(grants()).toEqual([]);
    h.stop();
  });

  test("a repository admin who is no site admin mounts the screen and gets no rows and no keys", async () => {
    // The action sees a repository admin, so only `canChange` stands between
    // them and the list and the keys.
    const before = changes().length;
    const view = await egressView(forge, erin, repo);
    expect(view.ok && view.value.rows.length).toBe(2);
    // Wide enough that the About card's hint line reaches `e  egress`.
    const terminal = headlessTerminal(180, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: erin };
    const { app, session } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const screen = egressScreen(session, app.ctx, repo);
    app.ctx.push(screen);
    await settleApp(app);
    expect(app.screen.toText()).not.toContain(ARM);
    expect(app.screen.toText()).not.toContain(CAMERA);
    expect(screen.keys.flatMap((b) => b.keys)).not.toContain("g");
    expect(screen.keys.flatMap((b) => b.keys)).not.toContain("x");
    for (const key of ["g", "x"])
      app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    expect(grants()).toEqual([]);
    expect(changes().length).toBe(before);
    app.stop();
  });
});
