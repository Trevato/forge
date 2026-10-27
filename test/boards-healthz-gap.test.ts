/**
 * A /boards load never stalls /healthz (#6973, first step of #6897): the flow panel reads the
 * open crew pulls and their last pushes; at the forge's size that read once stopped the HTTP
 * loop. Polled every 25 ms during the load, /healthz never goes 250 ms without an answer.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const REPOS = 20;
const PULLS_PER_REPO = 25; // 500 open crew pulls
const EVENTS = 50_000;
const POLL_MS = 25;
const MAX_GAP_MS = 250;

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-boards-healthz-gap-"));
  app = createApp({ dataDir: root, port: 0 });
  const mk = async (username: string, first: boolean): Promise<string> => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value.id;
  };
  const person = await mk("alice", true);
  const agent = await mk("scout", false);
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [agent]);
  const now = Date.now();
  const ago = (h: number): string => new Date(now - h * 3_600_000).toISOString();
  const repo = app.db.prepare(
    "INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, 'public')",
  );
  const issue = app.db.prepare(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, 'open', ?5)",
  );
  const pull = app.db.prepare(
    "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', NULL)",
  );
  const event = app.db.prepare(
    "INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'pull.pushed', ?2, ?3, ?4)",
  );
  app.db.transaction(() => {
    for (let r = 0; r < REPOS; r++) {
      repo.run(`r${r}`, person, `repo${r}`);
      for (let n = 1; n <= PULLS_PER_REPO; n++) {
        const id = `p${r}-${n}`;
        issue.run(id, `r${r}`, n, agent, ago(100));
        pull.run(id, `b${n}`);
      }
    }
    for (let e = 0; e < EVENTS; e++) {
      const r = e % REPOS;
      const n = (e % PULLS_PER_REPO) + 1;
      event.run(`e${e}`, `r${r}`, JSON.stringify({ number: n }), ago(1 + (e % 200)));
    }
  })();
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
  servers?.stop?.();
  app?.close?.();
  rmSync(root, { recursive: true, force: true });
});

test("loading /boards as an admin never leaves /healthz unanswered for 250 ms", async () => {
  expect(cookie).not.toBe("");
  const started = performance.now();
  let last = started;
  let longest = 0;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const res = await fetch(`${servers.url}/healthz`);
      await res.text();
      const at = performance.now();
      longest = Math.max(longest, at - last);
      last = at;
      await Bun.sleep(POLL_MS);
    }
  })();
  await Bun.sleep(100); // a few healthy answers before the load
  const page = await fetch(`${servers.url}/boards`, { headers: { cookie } });
  const html = await page.text();
  polling = false;
  await poller;
  expect(page.status).toBe(200);
  expect(html.length).toBeGreaterThan(0);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(
    longest,
    `longest gap between /healthz answers was ${longest.toFixed(0)} ms (limit ${MAX_GAP_MS} ms)`,
  ).toBeLessThanOrEqual(MAX_GAP_MS);
});
