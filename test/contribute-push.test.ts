/**
 * An outside agent's push (#12013): accepted on its own contrib branch over
 * https, it opens a pull (the commit message is the body) and prints the pull's
 * URL and the plain-text check URL; a later push updates the same pull; a push
 * to main, to another token's branch, or after expiry is refused in one line;
 * the size cap and the pull caps refuse with their numbers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintContributeToken, setOutsideContributions } from "../src/actions/contribute_token.ts";
import { pullWords } from "../src/actions/contribute_push.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {
  CONTRIBUTE_PUSH_MAX_BYTES,
  OPEN_PULLS_PER_TOKEN,
  PULLS_PER_AGENT_DAY,
  PULLS_PER_REPO_DAY,
  PULLS_PER_TOKEN_DAY,
  contribNamespace,
  inTurn,
} from "../src/core/contribute_token.ts";
import { verifyToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the pull's words", () => {
  test("the first line is the title and the whole message the body", () => {
    expect(pullWords("Fix the bug\n\nIt was off by one.\n", "contrib/x/y/z")).toEqual({
      title: "Fix the bug",
      body: "Fix the bug\n\nIt was off by one.",
    });
    expect(pullWords("", "contrib/x/y/z").title).toBe("contrib/x/y/z");
  });
});

describe("one open at a time per token", () => {
  test("calls with one key run in order, never together; other keys are not held", async () => {
    const log: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const job = (name: string, wait?: Promise<void>) => async () => {
      log.push(`${name}:start`);
      await wait;
      log.push(`${name}:end`);
    };
    // "a" holds its turn until "c" (another key) has run and "b" is queued behind it.
    const all = Promise.all([
      inTurn("k", job("a", held)),
      inTurn("k", job("b")),
      inTurn("other", job("c")).then(() => release()),
    ]);
    await all;
    expect(log.indexOf("a:end")).toBeLessThan(log.indexOf("b:start"));
    expect(log.indexOf("c:start")).toBeLessThan(log.indexOf("a:end"));
  });
  test("a failing call does not block the next", async () => {
    await inTurn("f", async () => Promise.reject(new Error("x"))).catch(() => undefined);
    expect(await inTurn("f", async () => 7)).toBe(7);
  });
});

describe("pushing with a contribute token", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let work: string;
  let seq = 0;

  const git = async (args: string[], cwd = work) => {
    const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
      cwd,
      env: gitClientEnv({ GIT_TERMINAL_PROMPT: "0" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-contrib-push-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const r = await createRepo(app, made.value, { name: "lib", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    const seeded = await commitToBranch(app, made.value, r.value, {
      branch: "main",
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    setOutsideContributions(app, made.value, r.value, true);
    work = join(dataDir, "work");
    expect((await git(["clone", `${servers.url}/alice/lib.git`, work], dataDir)).code).toBe(0);
    await git(["config", "user.email", "codex@example.com"]);
    await git(["config", "user.name", "codex"]);
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const token = async (agent: string, expired = false) => {
    const m = await mintContributeToken(app, { agent, origin: "test", repo: "alice/lib" }, `203.0.113.${++seq}`, "https://forge.test");
    if (!m.ok) throw new Error(`mint: ${JSON.stringify(m.error)}`);
    const v = verifyToken(app.db, m.value.token) as { ok: true; value: { user: User } };
    if (expired) app.db.query("UPDATE token SET expires_at = ?1 WHERE id = ?2").run(new Date(Date.now() - 1000).toISOString(), m.value.id);
    return {
      ns: contribNamespace(agent, m.value.id),
      id: m.value.id,
      userId: v.value.user.id,
      url: `${servers.url.replace("://", `://${v.value.user.username}:${m.value.token}@`)}/alice/lib.git`,
    };
  };
  const commit = async (message: string, file = `f${++seq}.md`, content = "x\n") => {
    await Bun.write(join(work, file), content);
    await git(["add", "."]);
    await git(["commit", "-m", message]);
  };
  const plain = (err: string) => err.split("\n").filter((l) => l.startsWith("remote:"));

  test("a new contrib branch opens a pull, prints its URLs, and a later push updates it", async () => {
    const t = await token("codex");
    await commit("Add a fix\n\nIt explains itself.");
    const first = await git(["push", t.url, `HEAD:contrib/${t.ns}/fix`]);
    expect(first.code).toBe(0);
    const pull = /remote: opened pull #(\d+): (http\S+\/alice\/lib\/pulls\/\d+)/.exec(first.err);
    expect(pull).not.toBeNull();
    const checks = /remote: checks \(plain text\): (http\S+\/pulls\/\d+\/checks\?format=text)/.exec(first.err);
    expect(checks).not.toBeNull();
    // The printed URLs lead where they say: path on the server the test talks to.
    const page = await fetch(`${servers.url}${new URL(pull![2]!).pathname}`);
    expect(page.status).toBe(200);
    const text = await fetch(`${servers.url}${new URL(checks![1]!).pathname}${new URL(checks![1]!).search}`);
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toContain("state:");
    const api = (await (await fetch(`${servers.url}/api/v1/repos/alice/lib/pulls/${pull![1]}`)).json()) as { title: string; body: string };
    expect(api.title).toBe("Add a fix");
    expect(api.body).toContain("It explains itself.");

    await commit("More");
    const second = await git(["push", t.url, `HEAD:contrib/${t.ns}/fix`]);
    expect(second.code).toBe(0);
    expect(second.err).toContain(`remote: updated pull #${pull![1]}: `);
    expect(second.err).not.toContain("opened pull");
  });

  test("a push to main, to another token's branch, or after expiry is refused in one line", async () => {
    const t = await token("codex");
    const other = await token("codex");
    await commit("Wrong places");
    const toMain = await git(["push", t.url, "HEAD:main"]);
    expect(toMain.code).not.toBe(0);
    expect(plain(toMain.err).join("\n")).toContain(`this token pushes only contrib/${t.ns}/`);
    const elsewhere = await git(["push", t.url, `HEAD:contrib/${other.ns}/fix`]);
    expect(elsewhere.code).not.toBe(0);
    expect(plain(elsewhere.err).join("\n")).toContain(`this token pushes only contrib/${t.ns}/`);
    // A token past its expiry.
    const old = await token("codex", true);
    const expired = await git(["push", old.url, `HEAD:contrib/${old.ns}/fix`]);
    expect(expired.code).not.toBe(0);
    expect(expired.err).not.toContain("opened pull");
    expect(expired.err).toContain("Authentication failed");
  });

  test("a push over the size cap is refused with the number", async () => {
    const t = await token("big");
    // Random bytes, so the pack cannot shrink below the cap.
    const noise = crypto.getRandomValues(new Uint8Array(1024 * 1024));
    const big = new Uint8Array(CONTRIBUTE_PUSH_MAX_BYTES + 1024 * 1024);
    for (let i = 0; i < big.length; i += noise.length) {
      big.set(crypto.getRandomValues(noise).subarray(0, Math.min(noise.length, big.length - i)), i);
    }
    const base = (await git(["rev-parse", "HEAD"])).out.trim();
    try {
      await Bun.write(join(work, "big.bin"), big);
      await git(["add", "."]);
      await git(["commit", "-m", "Too much"]);
      const pushed = await git(["push", t.url, `HEAD:contrib/${t.ns}/big`]);
      expect(pushed.code).not.toBe(0);
      expect(pushed.err).toContain("5.00 MiB");
      expect(CONTRIBUTE_PUSH_MAX_BYTES).toBe(5 * 1024 * 1024);
    } finally {
      await git(["reset", "--hard", base]);
    }
  });

  test("a token's pull cap refuses the next new branch with the number", async () => {
    const t = await token("spam");
    for (let i = 0; i < OPEN_PULLS_PER_TOKEN; i++) {
      await commit(`Change ${i}`);
      const ok = await git(["push", t.url, `HEAD:contrib/${t.ns}/p${i}`]);
      expect(ok.code).toBe(0);
      expect(ok.err).toContain("opened pull");
    }
    await commit("One too many");
    const over = await git(["push", t.url, `HEAD:contrib/${t.ns}/more`]);
    expect(over.code).not.toBe(0);
    expect(over.err).toContain(`${OPEN_PULLS_PER_TOKEN} pulls open`);
    // A branch already pulled may still be pushed to.
    expect((await git(["push", t.url, `HEAD:contrib/${t.ns}/p0`, "--force"])).code).toBe(0);
  });

  test("one push may not create more branches than the token has pulls to open", async () => {
    const t = await token("wide");
    await commit("Wide");
    const refs = Array.from({ length: OPEN_PULLS_PER_TOKEN + 1 }, (_, i) => `HEAD:contrib/${t.ns}/w${i}`);
    const pushed = await git(["push", t.url, ...refs]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain(`creates ${OPEN_PULLS_PER_TOKEN + 1} new branches and this token may open ${OPEN_PULLS_PER_TOKEN} more pulls`);
    expect((await git(["ls-remote", t.url])).out).not.toContain(`contrib/${t.ns}/w0`);
  });

  describe("the day's caps", () => {
    const seed = (userId: string, n: number) => {
      const repoId = (app.db.query("SELECT id FROM repo WHERE name = 'lib'").get() as { id: string }).id;
      for (let i = 0; i < n; i++)
        app.db
          .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', 'x', ?4, 'closed')")
          .run(`cap-${userId}-${i}`, repoId, 5000 + ++seq, userId);
    };
    // Pulls of earlier tests are a day old here: only the seeded ones count.
    beforeAll(() => {
      app.db.query("UPDATE issue SET created_at = ?1 WHERE kind = 'pull'").run(new Date(Date.now() - 3 * 86_400_000).toISOString());
    });
    const clear = () => app.db.query("DELETE FROM issue WHERE id LIKE 'cap-%'").run();
    const refused = async (t: { url: string; ns: string }) => {
      await commit("Over");
      const pushed = await git(["push", t.url, `HEAD:contrib/${t.ns}/over`]);
      expect(pushed.code).not.toBe(0);
      return pushed.err;
    };

    test("a token that opened its day's pulls is refused with the number", async () => {
      const t = await token("daily");
      try {
        seed(t.userId, PULLS_PER_TOKEN_DAY);
        expect(await refused(t)).toContain(`this token has opened ${PULLS_PER_TOKEN_DAY} pulls in a day`);
      } finally {
        clear();
      }
    });

    test("the tokens of one agent name share a day, however many are minted", async () => {
      const a = await token("loop");
      const b = await token("loop");
      try {
        seed(a.userId, PULLS_PER_TOKEN_DAY - 1);
        seed(b.userId, PULLS_PER_AGENT_DAY - PULLS_PER_TOKEN_DAY + 1);
        expect(await refused(b)).toContain(`this agent name has opened ${PULLS_PER_AGENT_DAY} pulls in a day`);
        // Another name is not held to it.
        const other = await token("loop2");
        await commit("Fine");
        expect((await git(["push", other.url, `HEAD:contrib/${other.ns}/ok`])).code).toBe(0);
      } finally {
        clear();
      }
    });

    test("a repository takes at most a day's worth from all outside tokens", async () => {
      const t = await token("one");
      try {
        // Fillers of distinct names, each under its own caps, together at the repository's.
        for (let left = PULLS_PER_REPO_DAY, i = 0; left > 0; i++, left -= PULLS_PER_TOKEN_DAY - 1)
          seed((await token(`filler${i}`)).userId, Math.min(left, PULLS_PER_TOKEN_DAY - 1));
        expect(await refused(t)).toContain(`takes at most ${PULLS_PER_REPO_DAY} pulls a day`);
      } finally {
        clear();
      }
    });
  });
});
