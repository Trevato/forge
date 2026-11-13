/**
 * `ssh <forge> tell <words>` (#6110): an exec of `tell` drives the same
 * `tell()` as the web composer, as the key's account, and says where it went.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { SAY_SOMETHING_WORDS } from "../src/actions/tell_words.ts";
import { MAX_BODY } from "../src/core/issues.ts";
import { TOO_LONG_WORDS, UNVERIFIED_WORDS } from "../src/actions/tell.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { getRepo } from "../src/core/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { appForLogin } from "../src/apps/tty.ts";
import { createUser } from "../src/core/users.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";
import { DIRECTION_NOTE } from "../src/crew/direct.ts";
import { GUEST_RATE_WORDS } from "../src/tui/ssh-guest-rate.ts";
import { ACCOUNT_NEEDED_WORDS, CONTROL_WORDS, NO_CREW_WORDS } from "../src/tui/ssh-tell.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo alice";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZ0w2ZbWQyPqkYtQmXkQ3q6e5rTn1b3G9m1x2yVd7pH bob";
const KEY_STRANGER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SzdnnnBlJkdPJ9K0iwGlfqsvLiLD3LKh nobody";

describe("ssh forge tell", () => {
  let dir = "";
  let app: App;
  const issues = () =>
    app.db.query<{ title: string; body: string }, []>("SELECT title, body FROM issue ORDER BY number").all();

  const exec = async (key: string, command: string, username = "whoever") => {
    const parsed = parseAuthorizedKey(key);
    if (!parsed.ok) throw new Error("key");
    let out = "";
    let err = "";
    let code: number | undefined;
    const done = new Promise<void>((resolve) => {
      const session = {
        key: { fingerprint: fingerprint(parsed.value.blob), line: key },
        username,
        remoteAddress: "203.0.113.9",
        kind: "exec" as const,
        command,
        term: undefined,
        env: {},
        cols: 0,
        rows: 0,
        widthPx: 0,
        heightPx: 0,
        ended: false,
        pending: 0,
        write(d: Uint8Array | string) {
          out += typeof d === "string" ? d : Buffer.from(d).toString();
        },
        writeStderr(d: string) {
          err += d;
        },
        onData() {},
        onResize() {},
        onEof() {},
        onClose() {},
        exit(c: number) {
          if (code !== undefined) return;
          code = c;
          resolve();
        },
        drained: async () => {},
      };
      forgeSshSession(app)(session as never);
    });
    await done;
    return { out, err, code };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-ssh-tell-"));
    app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge", url: "https://forge.test" });
    const mk = async (username: string, trusted: boolean, key: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!u.ok) throw new Error(u.error);
      const parsed = parseAuthorizedKey(key);
      if (!parsed.ok) throw new Error("key");
      addKey(app.db, u.value.id, "laptop", parsed.value);
      return u.value;
    };
    const alice = await mk("alice", true, KEY_A);
    promote(app.db, await mk("bob", false, KEY_B));
    promote(app.db, alice);
    const made = await createRepo(app, alice, { owner: "alice", name: "forge" });
    if (!made.ok) throw new Error(`repo ${made.error}`);
    // Bob may direct the crew here, so only his unproven email stops him.
    app.db.query("UPDATE repo SET crew_outsiders = 1, visibility = 'public' WHERE id = ?1").run(made.value.id);
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a known key tells the crew, with the words as given, and is told where it went", async () => {
    const r = await exec(KEY_A, "tell make $HOME `id` blue; rm -rf /");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("https://forge.test/alice/forge/issues/1");
    expect(r.out.split("\r\n")[0]!.length).toBeGreaterThan(0);
    expect(issues()).toEqual([{ title: "make $HOME `id` blue; rm -rf /", body: "" }]);
  });

  test("an unknown key is refused and records nothing", async () => {
    const r = await exec(KEY_STRANGER, "tell hello");
    expect(r.code).toBe(1);
    expect(r.err).toContain(ACCOUNT_NEEDED_WORDS);
    expect(r.out).toBe("");
    expect(issues().length).toBe(1);
  });

  test("empty words, too many words, control characters and an unverified account record nothing", async () => {
    const empty = await exec(KEY_A, "tell   ");
    expect([empty.code, empty.err]).toEqual([1, `forge: ${SAY_SOMETHING_WORDS}\r\n`]);
    const bare = await exec(KEY_A, "tell");
    expect(bare.err).toContain(SAY_SOMETHING_WORDS);
    const long = await exec(KEY_A, `tell ${"x".repeat(MAX_BODY + 1)}`);
    expect([long.code, long.err]).toEqual([1, `forge: ${TOO_LONG_WORDS}\r\n`]);
    for (const bad of ["tell a\x1b[2Jb", "tell a\nb", "tell a\x00b"]) {
      const r = await exec(KEY_A, bad);
      expect([r.code, r.err]).toEqual([1, `forge: ${CONTROL_WORDS}\r\n`]);
    }
    const unverified = await exec(KEY_B, "tell hello");
    expect([unverified.code, unverified.err]).toEqual([1, `forge: ${UNVERIFIED_WORDS}\r\n`]);
    expect(issues().length).toBe(1);
  });

  test("git commands and other words are still git or nothing", async () => {
    const r = await exec(KEY_A, "telling hello");
    expect(r.code).toBe(1);
    expect(r.err).toContain("only git");
    expect(issues().length).toBe(1);
  });

  test("a forge with no code repository refuses, and records nothing", async () => {
    const named = app.config.forgeRepo;
    try {
      for (const gone of [undefined, "alice/missing"]) {
        if (gone === undefined) delete app.config.forgeRepo;
        else app.config.forgeRepo = gone;
        const r = await exec(KEY_A, "tell hello");
        expect([r.code, r.err]).toEqual([1, `forge: ${NO_CREW_WORDS}\r\n`]);
      }
    } finally {
      if (named !== undefined) app.config.forgeRepo = named;
    }
    expect(issues().length).toBe(1);
  });

  test("a verified account that may not direct the crew is told so, and records nothing", async () => {
    app.db.query("UPDATE repo SET crew_outsiders = 0").run();
    app.db.query("UPDATE email_check SET verified_at = ?1 WHERE verified_at IS NULL").run(new Date().toISOString());
    try {
      const r = await exec(KEY_B, "tell hello");
      expect([r.code, r.err]).toEqual([1, `forge: ${DIRECTION_NOTE}\r\n`]);
    } finally {
      app.db.query("UPDATE repo SET crew_outsiders = 1").run();
      app.db.query("UPDATE email_check SET verified_at = NULL WHERE user_id = (SELECT id FROM user WHERE username = 'bob')").run();
    }
    expect(issues().length).toBe(1);
  });

  test("on an app's login a tell goes through the app gate to the app's crew, said from the app", async () => {
    const repo = getRepo(app.db, "alice", "forge")!;
    app.db
      .query("INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES ('app-tell-1', ?1, 'notes', 'public', 'copy')")
      .run(repo.id);
    const record = appForLogin(app, "notes")!.app;
    const address = new AppsRuntime(app, { domain: "forge.test", scheme: "https", publicPort: 443, forgeUrl: "https://forge.test" }).urlFor(record, "production");
    expect(address).toBe("https://notes.forge.test");
    const before = issues().length;
    // A writer.
    const w = await exec(KEY_A, "tell make the header blue", "notes");
    expect([w.code, w.err]).toEqual([0, ""]);
    expect(w.out).toContain("https://forge.test/alice/forge/issues/");
    const row = app.db.query<{ body: string }, []>("SELECT body FROM issue ORDER BY number DESC LIMIT 1").get()!;
    expect(row.body).toContain(`Told from [${address}](${address})`);
    expect(issues().length).toBe(before + 1);
    // A reader who may tell: verified, and the crew takes outsiders.
    app.db.query("UPDATE email_check SET verified_at = ?1 WHERE user_id = (SELECT id FROM user WHERE username = 'bob')").run(new Date().toISOString());
    const r = await exec(KEY_B, "tell and the footer", "notes");
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(issues().length).toBe(before + 2);
    // /asked shows it.
    const asked = app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE body LIKE ?1").get(`%${address}%`)!;
    expect(asked.n).toBe(2);
    // Words still refused on the app's login are refused as before.
    const empty = await exec(KEY_A, "tell", "notes");
    expect([empty.code, empty.err]).toEqual([1, `forge: ${SAY_SOMETHING_WORDS}\r\n`]);
    expect(issues().length).toBe(before + 2);
  });

  test("a viewer who cannot enter the app gets `no app named`, and nothing is recorded", async () => {
    const alice = getRepo(app.db, "alice", "forge")!;
    app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(alice.id);
    app.db.query("UPDATE repo SET crew_outsiders = 0 WHERE id = ?1").run(alice.id);
    const before = issues().length;
    try {
      const bob = await exec(KEY_B, "tell hello", "notes");
      expect([bob.code, bob.err, bob.out]).toEqual([1, "forge: no app named notes\r\n", ""]);
      const stranger = await exec(KEY_STRANGER, "tell hello", "notes");
      expect(stranger.code).toBe(1);
      expect(stranger.err).toContain("notes");
      expect(issues().length).toBe(before);
    } finally {
      app.db.query("UPDATE repo SET visibility = 'public', crew_outsiders = 1 WHERE id = ?1").run(alice.id);
    }
  });

  test("a guest's tell and talk share a rate; a signed-in key is not held to it", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) seen.push((await exec(KEY_STRANGER, i % 2 === 0 ? "tell hi" : "talk hi")).err);
    expect(seen.some((e) => e.includes(GUEST_RATE_WORDS))).toBe(true);
    expect(seen.slice(0, 2).every((e) => !e.includes(GUEST_RATE_WORDS))).toBe(true);
    const known = await exec(KEY_A, "tell still allowed");
    expect(known.err).not.toContain(GUEST_RATE_WORDS);
  });
});
