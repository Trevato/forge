/**
 * Trusted sources in the terminal (#8937): a forge admin who is a person is
 * offered the screen, `a` trusts, `x` removes, `s` stops and resumes folding
 * in, `v` opens reverts — each through `actions/trusted_sources.ts`, so each
 * leaves the web's event. Anyone else is not offered it, and its keys do
 * nothing when it is pushed anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { foldInStopped, listTrusted, trustSource } from "../src/core/trusted_sources.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { trustedScreen } from "../src/tui/screens/trusted.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const ENTER = "\r";
const RIGHT = "\x1b[C";

let dir: string;
let app: App;
let ada: User; // the forge admin
let bob: User; // signed in, not an admin

const identity = (user: User) => ({ sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

const events = (kind: string): number =>
  app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM event WHERE kind = ?1").get(kind)!.n;

/** Opens the screen as `user`, feeds each key in turn, and returns what is drawn. */
async function drive(user: User, keys: readonly string[] = []) {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  const offered = tui.commands.some((c) => c.id === "trusted");
  tui.ctx.push(trustedScreen(session, tui.ctx));
  await settleApp(tui);
  for (const key of keys) {
    terminal.feed(key);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return { offered, text };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-trusted-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  ada = await mk("ada", true);
  bob = await mk("bob");
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("trusted sources in the terminal", () => {
  test("a non-admin is not offered the screen, and its keys change nothing", async () => {
    const made = trustSource(app.db, { host: "elsewhere.test", account: "zed", until: "2099-01-01", setBy: "ada" });
    if (typeof made === "string") throw new Error(made);
    const { offered, text } = await drive(bob, ["a", "zoe elsewhere.test 2099-01-01", ENTER, "x", RIGHT, ENTER, "s", RIGHT, ENTER, "v", RIGHT, ENTER]);
    expect(offered).toBe(false);
    expect(text).toContain("Only a forge admin changes who is trusted.");
    expect(text).not.toContain("zed");
    expect(listTrusted(app.db).map((s) => s.account)).toEqual(["zed"]);
    expect(foldInStopped(app.db)).toBeUndefined();
    for (const kind of ["trust.set", "trust.removed", "foldin.stopped", "trust.reverted"]) expect(events(kind)).toBe(0);
    app.db.query("DELETE FROM trusted_source").run();
  });

  test("an admin is offered it; a trusts a source until a date", async () => {
    const { offered, text } = await drive(ada, ["a", "jmoran git.open-platform.sh 2099-12-02", ENTER]);
    expect(offered).toBe(true);
    expect(text).toContain("jmoran  git.open-platform.sh");
    expect(text).toContain("until 2099-12-02");
    expect(listTrusted(app.db).map((s) => [s.account, s.host])).toEqual([["jmoran", "git.open-platform.sh"]]);
    expect(events("trust.set")).toBe(1);
  });

  test("a refuses a bad entry with the page's sentence and trusts nobody", async () => {
    const { text } = await drive(ada, ["a", "jmoran git.open-platform.sh 2001-01-01", ENTER]);
    expect(text).toContain("That date has passed.");
    expect(listTrusted(app.db)).toHaveLength(1);
    expect(events("trust.set")).toBe(1);
  });

  test("s stops all folding in after a confirm, and s again resumes it", async () => {
    // Cancel is the default: Enter alone stops nothing.
    await drive(ada, ["s", ENTER]);
    expect(foldInStopped(app.db)).toBeUndefined();
    const stopped = await drive(ada, ["s", RIGHT, ENTER]);
    expect(foldInStopped(app.db)?.by).toBe("ada");
    expect(stopped.text).toContain("Folding in is stopped (by ada)");
    expect(events("foldin.stopped")).toBe(1);
    await drive(ada, ["s", RIGHT, ENTER]);
    expect(foldInStopped(app.db)).toBeUndefined();
    expect(events("foldin.resumed")).toBe(1);
  });

  test("v opens reverts for the source under the cursor after a confirm", async () => {
    await drive(ada, ["v", ENTER]);
    expect(events("trust.reverted")).toBe(0);
    await drive(ada, ["v", RIGHT, ENTER]);
    const said = app.db
      .query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'trust.reverted'")
      .all()
      .map((e) => JSON.parse(e.payload));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ account: "jmoran", host: "git.open-platform.sh", opened: 0 });
  });

  test("x removes the source under the cursor after a confirm", async () => {
    await drive(ada, ["x", ENTER]);
    expect(listTrusted(app.db)).toHaveLength(1);
    const { text } = await drive(ada, ["x", RIGHT, ENTER]);
    expect(listTrusted(app.db)).toHaveLength(0);
    expect(text).not.toContain("jmoran  git.open-platform.sh");
    expect(events("trust.removed")).toBe(1);
  });
});
