import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

setDefaultTimeout(30_000);

const HOSTILE = `<script>alert(1)</script> & "q"`;

describe("social cards: public refs, private refs, hostile titles", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-og-cards-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    for (const [name, visibility] of [
      ["open", "public"],
      ["vault", "private"],
    ] as const) {
      const made = await createRepo(app, u.value, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
    const open = getRepo(app.db, "alice", "open")!;
    const vault = getRepo(app.db, "alice", "vault")!;
    const app1 = createApp(app.db, { repoId: open.id, slug: "open-app", access: "public" });
    if (!app1.ok) throw new Error(app1.error);
    const mk = (repoId: string, title: string, kind: "issue" | "pull") => {
      const i = createIssue(app.db, { repoId, authorId: u.value.id, title, kind });
      if (!i.ok) throw new Error(String(i.error));
      if (kind === "pull")
        app.db
          .query(
            `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
             VALUES (?1, 'main', 'topic', '', '', ?2)`,
          )
          .run(i.value.id, repoId);
    };
    mk(open.id, HOSTILE, "issue"); // #1
    mk(open.id, "A public pull", "pull"); // #2
    mk(vault.id, "Secret issue", "issue"); // #1
    mk(vault.id, "Secret pull", "pull"); // #2
    runId = createRun(app.db, { repoId: open.id, kind: "agent", summary: "did a thing" }).id;
  }, 60_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  const get = (path: string) => fetch(servers.url + path);

  test("each kind answers 200 svg with the security headers", async () => {
    const refs: Record<string, string> = {
      repo: "alice~open",
      app: "open-app",
      issue: "alice~open~1",
      pull: "alice~open~2",
      run: `alice~open~${runId}`,
      map: "alice~open",
    };
    for (const [kind, ref] of Object.entries(refs)) {
      const res = await get(`/og/${kind}/${ref}.svg`);
      expect(res.status, kind).toBe(200);
      expect(res.headers.get("content-type"), kind).toContain("image/svg+xml");
      expect(res.headers.get("x-content-type-options"), kind).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), kind).toBeTruthy();
      expect(res.headers.get("content-security-policy"), kind).toContain("default-src 'none'");
      expect(await res.text(), kind).toStartWith("<svg");
    }
  });

  test("a private repository's issue and pull are the same 404 as a missing ref", async () => {
    const missing = await get("/og/issue/alice~vault~99.svg");
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    for (const ref of ["issue/alice~vault~1", "pull/alice~vault~2"]) {
      const res = await get(`/og/${ref}.svg`);
      expect(res.status, ref).toBe(404);
      const body = await res.text();
      expect(body, ref).toBe(missingBody);
      expect(body).not.toContain("Secret");
    }
    const missingPull = await (await get("/og/pull/alice~vault~99.svg")).text();
    expect(await (await get("/og/pull/alice~vault~2.svg")).text()).toBe(missingPull);
  });

  test("a stranger's session gets the same 404", async () => {
    const s = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "mallory",
      email: "mallory@forge.local",
      password: "mallory-passphrase",
    });
    if (!s.ok) throw new Error(s.error);
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "mallory", password: "mallory-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).not.toBe("");
    for (const ref of ["issue/alice~vault~1", "pull/alice~vault~2"]) {
      const res = await fetch(`${servers.url}/og/${ref}.svg`, { headers: { cookie } });
      expect(res.status, ref).toBe(404);
      expect(await res.text()).not.toContain("Secret");
    }
  });

  test("a title's markup is escaped in the SVG", async () => {
    const res = await get("/og/issue/alice~open~1.svg");
    const svg = await res.text();
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/scrip");
    expect(svg).toContain("&amp; &quot;q&quot;");
  });
});
