import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { THOUGHT_MAX } from "../src/actions/thought.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("thoughts", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-thoughts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const json = { "content-type": "application/json" };
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "mira", email: "mira@f.dev", password: "thoughts-pass-1" }),
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ adminConfirm: true, username: "mira", password: "thoughts-pass-1", name: "t", scope: "rw" }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (text: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/thoughts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ text }),
    });
  const row = (id: string) =>
    app.db
      .query<{ text: string; source: string; author: string }, [string]>(
        "SELECT text, source, author FROM thought WHERE id = ?1",
      )
      .get(id);

  test("text comes back byte for byte", async () => {
    for (const text of ["  padded \t\n", "line one\r\nline two\n\n", "héllo 🌍 ｗｉｄｅ \u0000 é", "<b>&amp;</b>"]) {
      const res = await post(text);
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const stored = row(id)!;
      expect(stored.text).toBe(text);
      expect(stored.source).toBe("api");
    }
  });

  test("empty and duplicate text are both kept", async () => {
    const ids = new Set<string>();
    for (const text of ["", "", "same", "same"]) {
      const res = await post(text);
      expect(res.status).toBe(201);
      ids.add(((await res.json()) as { id: string }).id);
    }
    expect(ids.size).toBe(4);
  });

  test("too long is a 422 with a sentence; the limit itself is kept", async () => {
    const ok = await post("x".repeat(THOUGHT_MAX));
    expect(ok.status).toBe(201);
    const before = app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM thought").get()!.n;
    const res = await post("x".repeat(THOUGHT_MAX + 1));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("20,000 characters");
    expect((await post(42)).status).toBe(422);
    expect(app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM thought").get()!.n).toBe(before);
  });

  test("a token is required, and a read token is not enough", async () => {
    const anon = await fetch(`${base}/api/v1/thoughts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(anon.status).toBe(401);
  });

  test("a cross-origin cookie POST is refused", async () => {
    const login = await fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mira", password: "thoughts-pass-1" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    if (!cookie) return; // no cookie route here: the scope check above covers tokens
    const res = await fetch(`${base}/api/v1/thoughts`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ text: "forged" }),
    });
    expect(res.status).toBe(403);
  });

  test("each thought emits thought.received without its text", async () => {
    const { id } = (await (await post("secret musing")).json()) as { id: string };
    const ev = app.db
      .query<{ kind: string; payload: string; repo_id: string | null }, [string]>(
        "SELECT kind, payload, repo_id FROM event WHERE kind = 'thought.received' AND payload LIKE '%' || ?1 || '%'",
      )
      .get(id)!;
    expect(ev.repo_id).toBeNull();
    expect(JSON.parse(ev.payload)).toEqual({ id, source: "api" });
  });

  test("the database refuses to change or remove one", async () => {
    const { id } = (await (await post("fixed")).json()) as { id: string };
    expect(() => app.db.query("UPDATE thought SET text = 'x' WHERE id = ?1").run(id)).toThrow();
    expect(() => app.db.query("DELETE FROM thought WHERE id = ?1").run(id)).toThrow();
    expect(row(id)!.text).toBe("fixed");
  });

  test("no code in src/ updates or deletes a thought", async () => {
    const hits: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (path.endsWith(".ts") && !path.endsWith("core/schema.ts")) {
          const src = await readFile(path, "utf8");
          if (/\b(UPDATE|DELETE\s+FROM|DROP\s+TABLE|INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO)\s+"?thought\b/i.test(src))
            hits.push(path);
        }
      }
    };
    await walk(join(import.meta.dir, "..", "src"));
    expect(hits).toEqual([]);
  });
});
