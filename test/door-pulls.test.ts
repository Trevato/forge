/**
 * `ssh <app>@<forge> pulls` (#6109): the module that reads an app's open
 * pulls for a viewer, and the exec that prints them, driven through
 * `forgeSshSession` with a fake session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { OPEN_PULLS_SQL, openPulls } from "../src/apps/door_pulls.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";
import { promote } from "./helpers/members.ts";

const KEYS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo bob",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq5xkQ8iVtfZ3pQ5m9X1Jw0m1dZf0QYbPzv6H7eYv2k eve",
];

describe("an app's open pulls over ssh", () => {
  let dataDir: string;
  let app: App;
  let owner: User;
  let author: User;
  let stranger: User;
  let repo: Repo;
  let privateRepo: Repo;

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

  /** A pull row without a branch behind it: the module reads rows only. */
  const pull = (r: Repo, n: number, by: User, title: string, sealed = 0) => {
    const id = crypto.randomUUID();
    app.db
      .query(
        "INSERT INTO issue (id, repo_id, number, kind, title, author_id, sealed) VALUES (?, ?, ?, 'pull', ?, ?, ?)",
      )
      .run(id, r.id, n, title, by.id, sealed);
    app.db
      .query(
        "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', ?)",
      )
      .run(id, `h${n}`, `head${n}`);
    return id;
  };

  const run = (issueId: string, r: Repo, state: string, commit: string) =>
    app.db
      .query(
        "INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'check', ?, ?, ?)",
      )
      .run(crypto.randomUUID(), r.id, issueId, commit, state);

  /** Exec `pulls` on `login` as the holder of KEYS[i] (none: an unknown key). */
  async function exec(login: string, key: number, command = "pulls") {
    const parsed = parseAuthorizedKey(KEYS[key]!);
    if (!parsed.ok) throw new Error("key");
    let out = "";
    let err = "";
    let code: number | undefined;
    const closers: (() => void)[] = [];
    const session = {
      key: { fingerprint: fingerprint(parsed.value.blob), line: KEYS[key]! },
      username: login,
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
      write: (b: Uint8Array) => void (out += new TextDecoder().decode(b)),
      writeStderr: (s: string | Uint8Array) =>
        void (err += typeof s === "string" ? s : new TextDecoder().decode(s)),
      onData() {},
      onResize() {},
      onEof() {},
      onClose: (cb: () => void) => void closers.push(cb),
      exit(c: number) {
        if (code !== undefined) return;
        code = c;
        for (const cb of closers) cb();
      },
      drained: async () => {},
    };
    forgeSshSession(app)(session as never);
    for (let i = 0; i < 50 && code === undefined; i++) await Bun.sleep(10);
    return { out, err, code };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-door-pulls-"));
    app = createApp({ dataDir, port: 0 });
    owner = await person("olive", true);
    author = await person("bob");
    stranger = await person("eve");
    for (const [u, k] of [
      [author, 0],
      [stranger, 1],
    ] as const) {
      const parsed = parseAuthorizedKey(KEYS[k]!);
      if (!parsed.ok) throw new Error("key");
      expect(addKey(app.db, u.id, "k", parsed.value).ok).toBe(true);
    }
    const pub = await newApp(app, owner, { name: "hello", description: "", visibility: "public" });
    if (!pub.ok) throw new Error(String(pub.error));
    repo = pub.value.repo;
    const priv = await newApp(app, owner, { name: "secret", description: "", visibility: "private" });
    if (!priv.ok) throw new Error(String(priv.error));
    privateRepo = priv.value.repo;
    const ids: string[] = [];
    for (let n = 1; n <= 7; n++) ids.push(pull(repo, n, owner, `Pull ${n}`));
    pull(repo, 8, author, "Sealed fix", 1);
    pull(privateRepo, 1, owner, "Hidden");
    run(ids[6]!, repo, "ok", "head7");
    run(ids[5]!, repo, "failed", "head6");
    run(ids[4]!, repo, "ok", "old-head");
    run(ids[3]!, repo, "running", "head4");
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the query walks an index: no scan of run, pull or issue", () => {
    const plan = app.db
      .query<{ detail: string }, [string, number, string, number]>(`EXPLAIN QUERY PLAN ${OPEN_PULLS_SQL}`)
      .all(repo.id, 0, "", 5)
      .map((r) => r.detail);
    for (const line of plan)
      expect(line).not.toMatch(/\bSCAN (run|pull|issue)\b(?! USING)/);
    expect(plan.join("\n")).toMatch(/USING (COVERING )?INDEX/);
  });

  test("a guest sees the five newest unsealed pulls with their check words", async () => {
    const got = openPulls(app.db, repo, undefined);
    expect(got.map((p) => p.number)).toEqual([7, 6, 5, 4, 3]);
    const seen = await exec("hello", 1);
    // eve is a named user with no standing on the repo, which is public.
    expect(seen.out).toBe(
      [
        "#7 Pull 7 · green",
        "#6 Pull 6 · red",
        "#5 Pull 5 · none",
        "#4 Pull 4 · running",
        "#3 Pull 3 · none",
        "",
      ].join("\n"),
    );
    expect(seen.code).toBe(0);
  });

  test("a sealed pull is its author's, a writer's and an admin's alone", async () => {
    expect(openPulls(app.db, repo, author, 10).map((p) => p.number)[0]).toBe(8);
    expect(openPulls(app.db, repo, owner, 10).map((p) => p.number)[0]).toBe(8);
    expect(openPulls(app.db, repo, stranger, 10).map((p) => p.number)[0]).toBe(7);
    expect(openPulls(app.db, repo, undefined, 10).map((p) => p.number)[0]).toBe(7);
    const mine = await exec("hello", 0);
    expect(mine.out.split("\n")[0]).toBe("#8 Sealed fix · none");
  });

  test("a suspended account counts as a guest", () => {
    const gone = { ...author, suspendedAt: "2026-01-01T00:00:00Z" };
    expect(openPulls(app.db, repo, gone, 10).map((p) => p.number)[0]).toBe(7);
  });

  test("a viewer who cannot read the repository gets nothing", () => {
    expect(openPulls(app.db, privateRepo, stranger)).toEqual([]);
    expect(openPulls(app.db, privateRepo, undefined)).toEqual([]);
    expect(openPulls(app.db, privateRepo, owner).map((p) => p.title)).toEqual(["Hidden"]);
  });

  test("a named user who cannot read a private app is told there is none", async () => {
    const got = await exec("secret", 1);
    expect(got.err).toContain("no app named secret");
    expect(got.out).toBe("");
    expect(got.code).toBe(1);
  });

  test("control characters in a title are stripped", async () => {
    pull(repo, 9, owner, "Evil\x1b[31m red\x07\nnext\r\x00line");
    const got = await exec("hello", 1);
    expect(got.out.split("\n")[0]).toBe("#9 Evil[31m rednextline · none");
    expect(got.out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });

  test("other execs on an app's login are still git's", async () => {
    const got = await exec("hello", 1, "ls");
    expect(got.err).toContain("only git is available");
    expect(got.code).toBe(1);
  });
});
