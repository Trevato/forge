import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("og cards", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let runId = "";
  let privateRunId = "";
  let quietRunId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-og-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const u = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    for (const [name, visibility, slug] of [
      ["shown", "public", "shown-app"],
      ["hidden", "private", "hidden-app"],
      ["quiet", "public", "quiet-app"],
    ] as const) {
      const made = await createRepo(app, u.value, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const rec = createApp(app.db, {
        repoId: made.value.id,
        slug,
        access: slug === "quiet-app" ? "private" : "public",
      });
      if (!rec.ok) throw new Error(rec.error);
    }
    const idOf = (name: string) => {
      const r = getRepo(app.db, "alice", name);
      if (!r) throw new Error(name);
      return r;
    };
    const mk = (repo: string, title: string, kind: "issue" | "pull", sealed = false) => {
      const i = createIssue(app.db, {
        repoId: idOf(repo).id,
        authorId: u.value.id,
        title,
        kind,
        sealed,
      });
      if (!i.ok) throw new Error(String(i.error));
      if (kind === "pull")
        app.db
          .query(
            `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
             VALUES (?1, 'main', 'topic', '', '', ?2)`,
          )
          .run(i.value.id, idOf(repo).id);
    };
    mk("shown", "A public issue <b>", "issue"); // #1
    mk("shown", "A public pull", "pull"); // #2
    mk("shown", "A sealed report", "issue", true); // #3
    mk("shown", "A merged pull", "pull"); // #4
    app.db
      .query(
        `UPDATE pull SET merged_at = '2026-01-01T00:00:00Z' WHERE issue_id =
           (SELECT id FROM issue WHERE repo_id = ?1 AND number = 4)`,
      )
      .run(idOf("shown").id);
    app.db
      .query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND number = 4")
      .run(idOf("shown").id);
    mk("hidden", "A private issue", "issue"); // #1
    const run = (repo: string) =>
      createRun(app.db, { repoId: idOf(repo).id, kind: "agent", summary: "did a thing" }).id;
    runId = run("shown");
    privateRunId = run("hidden");
    quietRunId = run("quiet");
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { headers });

  for (const [kind, good, private_] of [
    ["repo", "alice~shown", "alice~hidden"],
    ["app", "shown-app", "hidden-app"],
  ] as const) {
    describe(kind, () => {
      test("200 with the card, cache and security headers", async () => {
        const res = await get(`/og/${kind}/${good}.svg`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("image/svg+xml");
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBeTruthy();
        expect(res.headers.get("content-security-policy")).toContain(
          "default-src 'none'",
        );
        expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
        expect(await res.text()).toStartWith("<svg");
      });

      test("304 on If-None-Match", async () => {
        const first = await get(`/og/${kind}/${good}.svg`);
        const etag = first.headers.get("etag")!;
        const again = await get(`/og/${kind}/${good}.svg`, {
          "if-none-match": etag,
        });
        expect(again.status).toBe(304);
        expect(await again.text()).toBe("");
        const other = await get(`/og/${kind}/${good}.svg`, {
          "if-none-match": '"nope"',
        });
        expect(other.status).toBe(200);
      });

      test("a private repo is 404", async () => {
        expect((await get(`/og/${kind}/${private_}.svg`)).status).toBe(404);
      });

      test("a private app on a public repo is 404", async () => {
        const ref = kind === "app" ? "quiet-app" : "alice~quiet";
        // The repo card is public (the repo is); only the app's is refused.
        expect((await get(`/og/${kind}/${ref}.svg`)).status).toBe(
          kind === "app" ? 404 : 200,
        );
      });

      test("an unknown or malformed ref is 404", async () => {
        for (const ref of ["nobody~nothing", "nothing", "a~b~c", "..%2Fx", "A_B"])
          expect((await get(`/og/${kind}/${ref}.svg`)).status).toBe(404);
      });
    });
  }

  describe("issue, pull and run", () => {
    test("a public issue, pull and run each answer with a card", async () => {
      for (const path of [
        "issue/alice~shown~1",
        "pull/alice~shown~2",
        `run/alice~shown~${runId}`,
      ]) {
        const res = await get(`/og/${path}.svg`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
        const body = await res.text();
        expect(body).toStartWith("<svg");
        expect(body).not.toContain("<b>");
        const again = await get(`/og/${path}.svg`, {
          "if-none-match": res.headers.get("etag")!,
        });
        expect(again.status).toBe(304);
      }
    });

    test("the card says what the thing is", async () => {
      expect(await (await get("/og/issue/alice~shown~1.svg")).text()).toContain("ISSUE");
      expect(await (await get("/og/pull/alice~shown~2.svg")).text()).toContain("PULL");
      expect(await (await get(`/og/run/alice~shown~${runId}.svg`)).text()).toContain("did a thing");
    });

    test("a merged pull says merged; an open one does not", async () => {
      const merged = await (await get("/og/pull/alice~shown~4.svg")).text();
      expect(merged).toContain("merged");
      expect(merged).toContain("closed");
      const open = await (await get("/og/pull/alice~shown~2.svg")).text();
      expect(open).not.toContain("merged");
    });

    test("private repos, sealed reports and unreadable runs are 404", async () => {
      for (const path of [
        "issue/alice~hidden~1",
        "issue/alice~shown~3",
        `run/alice~hidden~${privateRunId}`,
        `run/alice~quiet~${quietRunId}`,
      ]) {
        const res = await get(`/og/${path}.svg`);
        // quiet's repo is public but its app is private: the run is not readable.
        expect(res.status).toBe(404);
      }
    });

    test("the wrong kind, number or shape is 404", async () => {
      for (const path of [
        "issue/alice~shown~2", // a pull is not an issue card
        "pull/alice~shown~1",
        "issue/alice~shown~99",
        "issue/alice~shown~0",
        "issue/alice~shown~x",
        "issue/alice~shown",
        "run/alice~shown~nope",
        `run/alice~shown~${runId}~x`,
        `run/alice~shown~${privateRunId}`, // another repo's run
      ])
        expect((await get(`/og/${path}.svg`)).status).toBe(404);
    });
  });
});
