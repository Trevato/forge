/** `/asked` names session, each read and render in Server-Timing, and costs a bounded number of statements for a person with 500 asks (#3358). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-asked-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const owner = { id: u.value.id, username: "alice" } as never;
  // 500 asks over 5 repositories; every other ask is closed by a merged pull.
  for (let r = 0; r < 5; r++) {
    const made = await createRepo(app, owner, { name: `r${r}` });
    if (!made.ok) throw new Error(made.error);
    for (let i = 0; i < 100; i++) {
      const ask = createIssue(app.db, { repoId: made.value.id, authorId: u.value.id, title: `Ask ${r}.${i}` });
      if (!ask.ok) throw new Error(ask.error);
      if (i % 2 === 1) continue;
      const pull = createIssue(app.db, {
        repoId: made.value.id,
        authorId: u.value.id,
        title: `Answers ${ask.value.number}`,
        body: `Closes #${ask.value.number}`,
        kind: "pull",
      });
      if (!pull.ok) throw new Error(pull.error);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
        )
        .run(pull.value.id, `b${i}`, new Date().toISOString());
    }
  }
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /asked names its phases and costs a bounded number of statements with 500 asks", async () => {
  const get = () => fetch(`${servers.url}/asked?show=all`, { headers: { cookie } });
  await (await get()).text();
  // The best of three: a shared runner's stall hits one request, not the page's cost.
  for (let i = 0; i < 3; i++) {
    const res = await get();
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("500 asked · 250 landed");
    const parts = (res.headers.get("server-timing") ?? "").split(", ");
    for (const name of ["app", "session", "repos", "counts", "asks", "thoughts", "flags", "render"])
      expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  }
  expectWork(await requestStatements(app.db, `${servers.url}/asked?show=all`, { headers: { cookie } }), { max: 35 });
});
