/**
 * `ssh <app>@<forge> pulls` (#6825): a title is text anyone with write can
 * set, so it reaches a terminal as one plain line; a refused viewer gets the
 * terminal's own refusal on stderr and nothing on stdout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { ttyRefusalText } from "../src/apps/tty.ts";
import { plainTitle, servePulls } from "../src/apps/tty_pulls.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";

describe("plainTitle", () => {
  test("drops ESC sequences, newlines, line separators and zero-width characters", () => {
    expect(plainTitle("a\x1b[31mred\x1b[0m")).toBe("a[31mred[0m");
    expect(plainTitle("a\x1b]0;owned\x07b")).toBe("a]0;ownedb");
    expect(plainTitle("one\r\ntwo\nthree")).toBe("onetwothree");
    expect(plainTitle("x\u2028y\u2029z")).toBe("xyz");
    expect(plainTitle("z\u200bw\u200d\u2060\ufeffj")).toBe("zwj");
    expect(plainTitle("\x9b31mc1")).toBe("31mc1");
  });

  test("trims and bounds the line at 120 characters", () => {
    expect(plainTitle("  padded  ")).toBe("padded");
    expect(plainTitle("a".repeat(500))).toBe("a".repeat(120));
  });
});

describe("servePulls", () => {
  let dataDir: string;
  let app: App;
  let owner: User;
  let stranger: User;
  let pub: { app: AppRecord; repo: Repo };
  let priv: { app: AppRecord; repo: Repo };

  const pull = (r: Repo, n: number, title: string, state?: string) => {
    const id = crypto.randomUUID();
    app.db
      .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?, ?, ?, 'pull', ?, ?)")
      .run(id, r.id, n, title, owner.id);
    app.db
      .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', ?)")
      .run(id, `h${n}`, `head${n}`);
    if (state)
      app.db
        .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'check', ?, ?, ?)")
        .run(crypto.randomUUID(), r.id, id, `head${n}`, state);
  };

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@f.dev`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };

  const fake = (username: string) => {
    const s = { out: "", err: "", code: undefined as number | undefined };
    const session = {
      username,
      write: (b: Uint8Array) => void (s.out += new TextDecoder().decode(b)),
      writeStderr: (d: string | Uint8Array) =>
        void (s.err += typeof d === "string" ? d : new TextDecoder().decode(d)),
      exit: (c: number) => void (s.code = c),
    };
    return { s, session: session as never };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tty-pulls-"));
    app = createApp({ dataDir, port: 0 });
    owner = await person("olive", true);
    stranger = await person("eve");
    const a = await newApp(app, owner, { name: "hello", description: "", visibility: "public" });
    if (!a.ok) throw new Error(String(a.error));
    pub = a.value;
    const b = await newApp(app, owner, { name: "secret", description: "", visibility: "private" });
    if (!b.ok) throw new Error(String(b.error));
    priv = b.value;
    pull(pub.repo, 1, "Plain", "ok");
    pull(pub.repo, 2, "Evil \x1b[2J\x1b]0;pwned\x07title\r\nfake line ", "failed");
    pull(pub.repo, 3, "Quiet");
    pull(priv.repo, 1, "Hidden");
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("writes one `#n title · check` line per open pull and exits 0", () => {
    const { s, session } = fake("hello");
    servePulls(app, session, owner, { app: pub.app, env: "production" });
    expect(s.out).toBe("#3 Quiet · none\n#2 Evil [2J]0;pwnedtitlefake line · red\n#1 Plain · green\n");
    expect(s.err).toBe("");
    expect(s.code).toBe(0);
  });

  test("no title puts an escape or a stray newline on the wire", () => {
    const { s, session } = fake("hello");
    servePulls(app, session, undefined, { app: pub.app, env: "production" });
    expect(s.out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f\u2028\u2029]/);
    expect(s.out.split("\n")).toHaveLength(4);
  });

  test("a viewer the gate refuses gets the terminal's refusal on stderr alone", () => {
    const { s, session } = fake("secret");
    servePulls(app, session, stranger, { app: priv.app, env: "production" });
    expect(s.out).toBe("");
    expect(s.err).toBe(`forge: ${ttyRefusalText("not_found", "secret")}\r\n`);
    expect(s.code).toBe(1);
    const guest = fake("secret");
    servePulls(app, guest.session, undefined, { app: priv.app, env: "production" });
    expect(guest.s.out).toBe("");
    expect(guest.s.err).toBe(`forge: ${ttyRefusalText("not_found", "secret")}\r\n`);
    expect(guest.s.code).toBe(1);
  });
});
