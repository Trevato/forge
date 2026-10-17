import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue, listIssues, nextNumber } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("issue core", () => {
  test("numbers are unique and monotonic across issues and pulls", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-iss-core-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const user = await createUser(app.db, { origin: "seed", trusted: true,
        username: "n",
        email: "n@f.dev",
        password: "numbers-please",
      });
      if (!user.ok) throw new Error("user");
      const repo = await createRepo(app.db, app.reposRoot, {
        ownerId: user.value.id,
        name: "r",
      });
      if (!repo.ok) throw new Error("repo");

      const a = createIssue(app.db, {
        repoId: repo.value.id,
        authorId: user.value.id,
        title: "first",
      });
      const b = createIssue(app.db, {
        repoId: repo.value.id,
        authorId: user.value.id,
        title: "second",
        kind: "pull",
      });
      const c = createIssue(app.db, {
        repoId: repo.value.id,
        authorId: user.value.id,
        title: "third",
      });
      expect([a, b, c].every((r) => r.ok)).toBe(true);
      if (!a.ok || !b.ok || !c.ok) return;
      expect([a.value.number, b.value.number, c.value.number]).toEqual([
        1, 2, 3,
      ]);

      // Listing an issue kind excludes pulls.
      expect(
        listIssues(app.db, repo.value.id, { state: "all", kind: "issue" }).map(
          (i) => i.number,
        ),
      ).toEqual([3, 1]);
      expect(nextNumber(app.db, repo.value.id)).toBe(4);

      const empty = createIssue(app.db, {
        repoId: repo.value.id,
        authorId: user.value.id,
        title: "   ",
      });
      expect(empty.ok).toBe(false);
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("issue pages end to end", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-iss-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username: "mel",
        email: "mel@f.dev",
        password: "issue-tracker-pass",
      }),
      redirect: "manual",
    });
    cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ name: "proj", visibility: "public" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("open an issue, it appears in the list and renders markdown safely", async () => {
    const created = await fetch(`${base}/mel/proj/issues/new`, {
      method: "POST",
      headers: { cookie },
      body: form({
        title: "First bug",
        body: "It is **broken**. <script>alert(1)</script>",
      }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/mel/proj/issues/1");

    const list = await (await fetch(`${base}/mel/proj/issues`)).text();
    expect(list).toContain("First bug");
    expect(list).toContain('href="/mel/proj/tells/1"');

    const detail = await (await fetch(`${base}/mel/proj/issues/1`)).text();
    expect(detail).toContain("<strong>broken</strong>");
    expect(detail).not.toContain("<script>alert");
  });

  test("comment on the issue and it shows in the thread", async () => {
    const commented = await fetch(`${base}/mel/proj/issues/1/comments`, {
      method: "POST",
      headers: { cookie },
      body: form({ intent: "comment", body: "I can repro this." }),
      redirect: "manual",
    });
    expect(commented.status).toBe(303);
    const detail = await (await fetch(`${base}/mel/proj/issues/1`)).text();
    expect(detail).toContain("I can repro this.");
  });

  // Closing is its own verb now: POST …/state, not an `intent` rider on the
  // comment endpoint. One endpoint, one thing it does.
  test("close and reopen from the thread", async () => {
    await fetch(`${base}/mel/proj/issues/1/state`, {
      method: "POST",
      headers: { cookie },
      body: form({ state: "closed" }),
      redirect: "manual",
    });
    let detail = await (await fetch(`${base}/mel/proj/issues/1`)).text();
    expect(detail).toContain('data-state="closed"');
    // Default list (open) no longer shows it; closed filter does.
    expect(await (await fetch(`${base}/mel/proj/issues`)).text()).toContain(
      "Nothing open.",
    );
    expect(
      await (await fetch(`${base}/mel/proj/issues?state=closed`)).text(),
    ).toContain("First bug");

    await fetch(`${base}/mel/proj/issues/1/state`, {
      method: "POST",
      headers: { cookie },
      body: form({ state: "open" }),
      redirect: "manual",
    });
    detail = await (await fetch(`${base}/mel/proj/issues/1`)).text();
    // Open again, the tell reads in its word: said, nobody has it yet.
    expect(detail).toContain('data-word="told"');
    expect(detail).not.toContain('data-state="closed"');
  });

  test("cross-origin issue post is refused (CSRF)", async () => {
    const res = await fetch(`${base}/mel/proj/issues/new`, {
      method: "POST",
      headers: { cookie, origin: "http://evil.example" },
      body: form({ title: "x", body: "" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  test("a stranger cannot see issues on a private repo", async () => {
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ name: "secret", visibility: "private" }),
      redirect: "manual",
    });
    await fetch(`${base}/mel/secret/issues/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ title: "hidden", body: "" }),
      redirect: "manual",
    });
    const anon = await fetch(`${base}/mel/secret/issues`);
    expect(anon.status).toBe(404);
    const anonIssue = await fetch(`${base}/mel/secret/issues/1`);
    expect(anonIssue.status).toBe(404);
  });

  test("non-numeric issue ids 404", async () => {
    expect((await fetch(`${base}/mel/proj/issues/abc`)).status).toBe(404);
    expect((await fetch(`${base}/mel/proj/issues/999`)).status).toBe(404);
  });

  test("the JSON API drives the full issue lifecycle", async () => {
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "mel",
        password: "issue-tracker-pass",
        name: "bot",
        scope: "rw",
      }),
    });
    const token = ((await minted.json()) as { token: string }).token;
    const auth = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const created = await fetch(`${base}/api/v1/repos/mel/proj/issues`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "from a bot", body: "filed via API" }),
    });
    expect(created.status).toBe(201);
    const num = ((await created.json()) as { number: number }).number;

    const commented = await fetch(
      `${base}/api/v1/repos/mel/proj/issues/${num}/comments`,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ body: "and a comment" }),
      },
    );
    expect(commented.status).toBe(201);

    const got = await (
      await fetch(`${base}/api/v1/repos/mel/proj/issues/${num}`, {
        headers: auth,
      })
    ).json();
    expect((got as { comments: unknown[] }).comments).toHaveLength(1);

    const closed = await fetch(`${base}/api/v1/repos/mel/proj/issues/${num}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ state: "closed" }),
    });
    expect(((await closed.json()) as { state: string }).state).toBe("closed");
  });

  test("a read-only token cannot open an issue via API", async () => {
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "mel",
        password: "issue-tracker-pass",
        name: "ro",
        scope: "ro",
      }),
    });
    const roToken = ((await minted.json()) as { token: string }).token;
    const res = await fetch(`${base}/api/v1/repos/mel/proj/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});
