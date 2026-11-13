/**
 * Releases in the terminal (#2079): the palette offers it, and the screen
 * shows the live line and the kept releases, only to a site admin or a reader
 * of FORGE_REPO; Enter rolls back only for a person who writes that
 * repository, and says so when the forge does not swap itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setMember } from "../src/core/roles.ts";
import { createUser, type User } from "../src/core/users.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { mayRead, mayRollBack } from "../src/release/gate.ts";
import { recordRelease } from "../src/release/record.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { journeyText, readReleases, releasesScreen } from "../src/tui/screens/releases.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const LIVE = "a".repeat(40);
const KEPT = "b".repeat(40);

describe("the releases screen", () => {
  let root = "";
  let app: App;
  let alice: User;
  let bob: User;
  let carol: User;
  const was = process.env["FORGE_COMMIT"];

  const identity = (user?: User) => ({
    sshUsername: user?.username ?? "git",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    user,
  });
  const offered = (user?: User) =>
    forgeCommands(new Session(app, identity(user)))({} as Ctx).some((c) => c.id === "releases");

  async function open(user: User, keys = ""): Promise<string> {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(releasesScreen(session, tui.ctx));
    await settleApp(tui);
    if (keys !== "") {
      terminal.feed(keys);
      await settleApp(tui);
    }
    const text = tui.screen.toText();
    tui.stop?.();
    return text;
  }

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = LIVE;
    root = mkdtempSync(join(tmpdir(), "forge-tui-releases-"));
    app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
    const mk = async (username: string, adminIfFirst: boolean) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    alice = await mk("alice", true);
    bob = await mk("bob", false);
    carol = await mk("carol", false);
    const made = await createRepo(app, alice, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const repoId = made.value.id;
    recordRelease(app.db, { sha: LIVE, repoId, pullNumber: 7, ok: true, line: "ok" });
    recordRelease(app.db, { sha: KEPT, repoId, pullNumber: 6, ok: true, line: "ok" });
    const dir = releaseDir(root, KEPT);
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    writeFileSync(
      join(dir, "src", "core", "schema.ts"),
      "export const migrations = " + JSON.stringify(Array(10_000).fill("SELECT 1")) + ";\n",
    );
  });
  afterAll(() => {
    if (was === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = was;
    app.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a non-reader is offered nothing and sees nothing", async () => {
    expect(offered(bob)).toBe(false);
    expect(offered(undefined)).toBe(false);
    expect(await readReleases(new Session(app, identity(bob)))).toEqual([]);
    const text = await open(bob);
    expect(text).not.toContain("bbbbbbb");
    expect(text).not.toContain("aaaaaaa");
  });

  test("a site admin sees the live line and the kept releases", async () => {
    expect(offered(alice)).toBe(true);
    const text = await open(alice);
    expect(text).toContain("live: aaaaaaa since");
    expect(text).toContain("bbbbbbb");
    expect(text).toContain("alice/forge #6");
    expect(text).toContain("healthy since");
  });

  test("a non-admin reader of FORGE_REPO sees nothing and gets no rollback", async () => {
    app.db.run("UPDATE repo SET visibility='public' WHERE name='forge'");
    expect(offered(carol)).toBe(false);
    expect(await readReleases(new Session(app, identity(carol)))).toEqual([]);
    expect(await open(carol, "j\r")).not.toContain("bbbbbbb");
  });

  test("an agent is refused a rollback, whatever it can read", async () => {
    const agent = { ...alice, kind: "agent" } as User;
    expect(mayRollBack(app, agent)).toBe(false);
    const lines = await readReleases(new Session(app, identity(agent)));
    expect(lines.length).toBe(2);
    expect(lines.every((l) => !l.rollable)).toBe(true);
  });

  test("a writer is asked to confirm, and is told when the forge does not swap itself", async () => {
    const lines = await readReleases(new Session(app, identity(alice)));
    expect(lines.find((l) => l.release.sha === KEPT)?.rollable).toBe(true);
    expect(lines.find((l) => l.release.sha === LIVE)?.rollable).toBe(false);
    const asking = await open(alice, "\r");
    expect(asking).toContain("Swap to bbbbbbb");
    const told = await open(alice, "\r\x1b[D\r");
    expect(told).toContain("FORGE_SELF_SWAP is off");
  });

  test("a member who writes FORGE_REPO is refused releases and rollback (#2384), in the rule, the palette and the screen", async () => {
    setMember(app.db, carol.id, true, alice.id, new Date());
    app.db.query("UPDATE repo SET owner_id = ?1 WHERE name = 'forge'").run(carol.id);
    app.config.forgeRepo = "carol/forge";
    try {
      expect(mayRead(app, carol)).toBe(false);
      expect(mayRollBack(app, carol)).toBe(false);
      expect(mayRead(app, alice) && mayRollBack(app, alice)).toBe(true);
      expect(offered(carol)).toBe(false);
      expect(await readReleases(new Session(app, identity(carol)))).toEqual([]);
      const text = await open(carol, "\r");
      expect(text).not.toContain("bbbbbbb");
      expect(text).not.toContain("Swap to");
      expect(offered(alice)).toBe(true);
    } finally {
      app.config.forgeRepo = "alice/forge";
    }
  });

  test("the stranger's journey line: present with a passing proof of the serving version, absent without, nothing for one who may not read", () => {
    const was = process.env["FORGE_VERSION"];
    process.env["FORGE_VERSION"] = "9.9.9";
    const proof = (o: object) => {
      mkdirSync(join(root, "release"), { recursive: true });
      writeFileSync(join(root, "release", "proof.json"), JSON.stringify({ at: new Date().toISOString(), ...o }));
    };
    const journey = { readyMs: 12_000, firstActivityMs: 41_000, screens: [] };
    try {
      const a = new Session(app, identity(alice));
      expect(journeyText(a)).toBeUndefined();
      proof({ version: "9.9.9", ok: true, journey });
      expect(journeyText(a)).toBe("a stranger's forge was ready in 12 s and the crew working in 41 s");
      expect(journeyText(new Session(app, identity(carol)))).toBeUndefined();
      expect(journeyText(new Session(app, identity(undefined)))).toBeUndefined();
      proof({ version: "9.9.9", ok: true });
      expect(journeyText(a)).toBeUndefined();
      proof({ version: "9.9.8", ok: true, journey });
      expect(journeyText(a)).toBeUndefined();
      proof({ version: "9.9.9", ok: false, journey });
      expect(journeyText(a)).toBeUndefined();
    } finally {
      if (was === undefined) delete process.env["FORGE_VERSION"];
      else process.env["FORGE_VERSION"] = was;
      rmSync(join(root, "release", "proof.json"), { force: true });
    }
  });
});
