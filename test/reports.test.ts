/**
 * A report from outside: anyone may tell a public repository that something
 * is wrong, with no account. The refusals come first, because the path is
 * open to strangers: text only, capped, limited per source, held apart from
 * issues, and never seen by an agent until a person who writes accepts it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("reports from outside", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let game: Repo;
  let aliceToken: string;
  let botToken: string;
  let carolToken: string;
  let sourceSeq = 0;
  /** A fresh source per call, so the per-source limit only binds where a test means it to. */
  const freshSource = () => `198.51.100.${++sourceSeq}`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reports-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const c = await createUser(app.db, {
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
    const made = await createRepo(app, alice, {
      name: "game",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    game = made.value;
    const vault = await createRepo(app, alice, {
      name: "vault",
      visibility: "private",
    });
    if (!vault.ok) throw new Error(String(vault.error));
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    expect(addToCrew(app, alice, game, "bot").ok).toBe(true);
    aliceToken = createToken(app.db, alice.id, "t", "rw").token;
    botToken = createToken(app.db, bot.value.user.id, "run", "rw").token;
    carolToken = createToken(app.db, c.value.id, "t", "rw").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const count = (table: string): number =>
    (app.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
      .n;

  const report = (
    repo: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/api/v1/repos/${repo}/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": freshSource(),
        ...headers,
      },
      body: JSON.stringify(payload),
    });

  const as = (token: string, path: string, method = "GET") =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });

  // ── refusals ──────────────────────────────────────────────────────────

  test("a private repository answers exactly as a missing one", async () => {
    const hidden = await report("alice/vault", { title: "t", body: "b" });
    const missing = await report("alice/nothing", { title: "t", body: "b" });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    expect(count("report")).toBe(0);
  });

  test("text only, capped: an empty title, a long title, a long body are refused", async () => {
    for (const [payload, code] of [
      [{ title: "", body: "b" }, "empty_title"],
      [{ title: "   ", body: "b" }, "empty_title"],
      [{ title: "x".repeat(201), body: "b" }, "title_too_long"],
      [{ title: "t", body: "x".repeat(8_001) }, "body_too_long"],
      [{ title: { nested: true }, body: "b" }, "empty_title"],
    ] as const) {
      const res = await report("alice/game", payload);
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).error).toBe(code);
    }
    const huge = await fetch(`${base}/api/v1/repos/alice/game/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshSource() },
      body: JSON.stringify({ title: "t", body: "x".repeat(70_000) }),
    });
    expect(huge.status).toBe(413);
    expect(count("report")).toBe(0);
  });

  test("control and direction-override characters never reach the stored text", async () => {
    const res = await report("alice/game", {
      title: "bad\u0000 ‮title",
      body: "line\u0007 one\nline two⁦",
      page: "javascript:alert(1)",
    });
    expect(res.status).toBe(202);
    const row = app.db
      .query("SELECT title, body, page FROM report ORDER BY id DESC LIMIT 1")
      .get() as { title: string; body: string; page: string | null };
    expect(row.title).toBe("bad title");
    expect(row.body).toBe("line one\nline two");
    // Only an http(s) address is kept as the page it came from.
    expect(row.page).toBeNull();
  });

  test("filing creates no account, no issue, no run, and no event carrying the text", async () => {
    const users = count("user");
    const issues = count("issue");
    const runs = count("run");
    const res = await report("alice/game", {
      title: "The game is down",
      body: "SECRET-PHRASE in the body",
      page: "https://game.example/",
    });
    expect(res.status).toBe(202);
    const out = (await res.json()) as any;
    expect(out.state).toBe("pending");
    expect(out.id).toBeString();
    expect(count("user")).toBe(users);
    expect(count("issue")).toBe(issues);
    expect(count("run")).toBe(runs);
    const leaked = app.db
      .query(
        "SELECT count(*) AS n FROM event WHERE payload LIKE '%SECRET-PHRASE%' OR payload LIKE '%The game is down%'",
      )
      .get() as { n: number };
    expect(leaked.n).toBe(0);
  });

  test("an agent on the crew cannot read, accept or dismiss a report", async () => {
    const listed = await as(botToken, "/api/v1/repos/alice/game/reports");
    expect(listed.status).toBe(403);
    expect(await listed.text()).not.toContain("SECRET-PHRASE");
    const pending = app.db
      .query("SELECT id FROM report WHERE state = 'pending' LIMIT 1")
      .get() as { id: string };
    for (const verb of ["accept", "dismiss"]) {
      const res = await as(
        botToken,
        `/api/v1/repos/alice/game/reports/${pending.id}/${verb}`,
        "POST",
      );
      expect(res.status).toBe(403);
    }
    // The agent's own issue list and search do not carry it either.
    const issues = await as(botToken, "/api/v1/repos/alice/game/issues");
    expect(await issues.text()).not.toContain("SECRET-PHRASE");
  });

  test("the owner's read-only token, the kind an app process holds, cannot read reports", async () => {
    const ro = createToken(app.db, alice.id, "app:game/production", "ro").token;
    expect((await as(ro, "/api/v1/repos/alice/game/reports")).status).toBe(403);
    const page = await as(ro, "/alice/game/reports");
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain("SECRET-PHRASE");
  });

  test("a signed-in reader who cannot write cannot read reports", async () => {
    const listed = await as(carolToken, "/api/v1/repos/alice/game/reports");
    expect(listed.status).toBe(403);
    const anon = await fetch(`${base}/api/v1/repos/alice/game/reports`);
    expect(anon.status).toBe(401);
  });

  test("one source is limited, and a refused report is not stored", async () => {
    const before = count("report");
    const source = { "x-forwarded-for": "203.0.113.9" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await report("alice/game", { title: `t${i}` }, source);
      statuses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(((await res.json()) as any).error).toBe("rate_limited");
      }
    }
    expect(statuses.slice(0, 3)).toEqual([202, 202, 202]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(count("report")).toBe(before + 3);
  });

  test("the web form's honeypot looks accepted and stores nothing", async () => {
    const before = count("report");
    const res = await fetch(`${base}/alice/game/report`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": freshSource(),
      },
      body: "title=spam&body=spam&website=http%3A%2F%2Fspam.example",
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(count("report")).toBe(before);
  });

  // ── the person's side ─────────────────────────────────────────────────

  test("anyone sees the form; the web form files a report", async () => {
    const form = await fetch(`${base}/alice/game/report`);
    expect(form.status).toBe(200);
    const page = await form.text();
    expect(page).toContain('name="title"');
    expect(page).toContain("no account");
    const before = count("report");
    const res = await fetch(`${base}/alice/game/report`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": freshSource(),
      },
      body: "title=%3Cscript%3Ex%3C%2Fscript%3E&body=It+froze",
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(count("report")).toBe(before + 1);
    const hidden = await fetch(`${base}/alice/vault/report`);
    expect(hidden.status).toBe(404);
  });

  test("the owner sees reports marked from outside, escaped, and only the owner", async () => {
    const anon = await fetch(`${base}/alice/game/reports`, {
      redirect: "manual",
    });
    expect(anon.status).not.toBe(200);
    const owner = await as(aliceToken, "/alice/game/reports");
    expect(owner.status).toBe(200);
    const page = await owner.text();
    expect(page).toContain("From outside");
    expect(page).not.toContain("<script>x</script>");
    expect(page).toContain("&lt;script&gt;");
    const bot = await as(botToken, "/alice/game/reports");
    expect(bot.status).not.toBe(200);
    expect(await bot.text()).not.toContain("SECRET-PHRASE");
  });

  test("accepting makes an ordinary issue by the person, the text fenced as unchecked", async () => {
    const listed = await as(aliceToken, "/api/v1/repos/alice/game/reports");
    expect(listed.status).toBe(200);
    const items = ((await listed.json()) as any).items as any[];
    const target = items.find((r) => r.title === "The game is down");
    expect(target.from).toBe("outside");
    const accepted = await as(
      aliceToken,
      `/api/v1/repos/alice/game/reports/${target.id}/accept`,
      "POST",
    );
    expect(accepted.status).toBe(201);
    const issue = (await accepted.json()) as any;
    expect(issue.title).toBe("The game is down");
    expect(issue.authorName).toBe("alice");
    expect(issue.body).toContain("from outside");
    expect(issue.body).toContain("```\nSECRET-PHRASE in the body\n```");
    // A decided report is decided once.
    const again = await as(
      aliceToken,
      `/api/v1/repos/alice/game/reports/${target.id}/accept`,
      "POST",
    );
    expect(again.status).toBe(409);
    const after = (await (
      await as(aliceToken, "/api/v1/repos/alice/game/reports")
    ).json()) as any;
    expect(after.items.some((r: any) => r.id === target.id)).toBe(false);
  });

  test("dismissing removes a report from the queue without an issue", async () => {
    const issues = count("issue");
    const listed = (await (
      await as(aliceToken, "/api/v1/repos/alice/game/reports")
    ).json()) as any;
    const target = listed.items[0];
    const res = await as(
      aliceToken,
      `/api/v1/repos/alice/game/reports/${target.id}/dismiss`,
      "POST",
    );
    expect(res.status).toBe(200);
    expect(count("issue")).toBe(issues);
  });

  test("a repository holds a bounded number of waiting reports", async () => {
    app.db.run("DELETE FROM report");
    const insert = app.db.query(
      "INSERT INTO report (id, repo_id, title, body) VALUES (?1, ?2, 't', '')",
    );
    for (let i = 0; i < 100; i++) insert.run(`fill${i}`, game.id);
    const res = await report("alice/game", { title: "one more" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error).toBe("queue_full");
  });
});
