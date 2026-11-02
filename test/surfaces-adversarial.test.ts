/**
 * Adversarial coverage for the web and TUI surfaces of apps, runs and the
 * crew (docs/APPS.md) — what `test/web-apps.test.ts` and `test/tui-apps.test.ts`
 * do not already prove: CSRF on the routes those files did not target,
 * rendering safety (a run log, an agent's brief, an issue title are all
 * attacker-controlled text), the strict CSP every new page must carry, that
 * a listing never pays a query per row, and a guest's reach in the terminal.
 *
 * No `AppsRuntime` runs here on purpose: every page under test renders from
 * rows alone (`runtime === undefined` is itself a first-class, already
 * exercised state — "Nothing is serving apps on this forge"), which keeps
 * this file fast and lets the N+1 assertions attribute every statement to
 * the code under test rather than to a deploy's own bookkeeping.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { quietLogs } from "./helpers/globals.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { content as contentStyle } from "../src/web/style/content.ts";
import { issuesScreen } from "../src/tui/screens/issues.ts";
import { local } from "../src/tui/screens/where.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { Session, TuiIdentity } from "../src/tui/session.ts";
import type { App as TuiApp, Screen } from "../src/tui/app/app.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { statements } from "./helpers/statements.ts";
import { settleApp } from "./helpers/tui.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();


// ============================================================================
// Web
// ============================================================================

describe("surfaces adversarial: web", () => {
  let dataDir = "";
  let app: Forge;
  let servers: Servers;
  let base = "";
  let alice = "";
  let alicePassword = "alice-adversarial-pass";

  const web = (
    cookie: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== "") headers.set("cookie", cookie);
    const method = init.form !== undefined ? "POST" : (init.method ?? "GET");
    if (init.form !== undefined)
      headers.set("origin", init.origin ?? new URL(base).origin);
    return fetch(`${base}${path}`, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(init.form === undefined
        ? {}
        : { body: new URLSearchParams(init.form) }),
    });
  };

  const bodyOf = async (cookie: string, path: string): Promise<string> => {
    const response = await web(cookie, path);
    expect(`${path} → ${response.status}`).toBe(`${path} → 200`);
    return await response.text();
  };

  const signUp = async (
    username: string,
    password = "a-good-passphrase-1",
  ): Promise<string> => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password,
      }),
      redirect: "manual",
    });
    return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-surfaces-adv-"));
    // The standing sweep queries on a timer; the N+1 counts are of requests alone.
    app = createApp({ dataDir, port: 0, standingSweepMs: 3_600_000 });
    servers = await serve(app);
    base = servers.url;
    alice = `${await adminCookie(app, { username: "alice", email: "alice@forge.test", password: alicePassword })}; forge_mode=dev`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // ---- 1. floors & CSRF on routes the other suite did not target ----

  test("CSRF: a pull's assignee and a run's cancel refuse a forged origin", async () => {
    const madeRepo = await createRepo(app, aliceUser(), {
      name: "csrf-repo",
      visibility: "public",
    });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    // A bare `issue` row of kind 'pull' is all `threadContext` needs.
    const issueId = id();
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
         VALUES (?1, ?2, 1, 'pull', 'CSRF target', '', ?3, 'open')`,
      )
      .run(issueId, repo.id, aliceUser().id);
    const runId = id();
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, state) VALUES (?1, ?2, 'deploy', 'production', 'running')`,
      )
      .run(runId, repo.id);

    for (const path of [
      `/alice/csrf-repo/pulls/1/assignee`,
      `/alice/csrf-repo/runs/${runId}/cancel`,
    ]) {
      const forged = await web(alice, path, {
        form: { assignee: "alice" },
        origin: "https://evil.example",
      });
      expect(`${path} → ${forged.status}`).toBe(`${path} → 403`);
    }
  });

  // ---- 2. open redirect ----

  test("open redirect: a malformed environment never reaches urlFor — it 404s first", async () => {
    const madeRepo = await createRepo(app, aliceUser(), {
      name: "redirect-repo",
      visibility: "public",
    });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    app.db
      .query(
        `INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, 'redirect-repo', 'public', 'copy')`,
      )
      .run(id(), repo.id);
    const evilEnvs = [
      "../production",
      "production%2F..",
      "pull-1..%2Fevil",
      "http://evil.example",
      "//evil.example",
      "production/../../evil",
      "pull-0",
      "pull--1",
      "pull-1e2",
      "PRODUCTION",
    ];
    for (const env of evilEnvs) {
      const response = await web(
        alice,
        `/alice/redirect-repo/app/${encodeURIComponent(env)}/open`,
      );
      // Never a redirect to anything other than this forge's own 404 —
      // in particular never a 302/303 carrying an off-forge Location.
      if (response.status === 302 || response.status === 303) {
        const location = response.headers.get("location") ?? "";
        expect(`${env} → ${location}`).toMatch(/^\/signin/);
      } else {
        expect(`${env} → ${response.status}`).toBe(`${env} → 404`);
      }
    }
    // A double slash inside the path segment splits the route itself, so it
    // never even reaches the handler — still never an open redirect.
    const split = await web(alice, `/alice/redirect-repo/app/pull-1/evil/open`);
    expect(split.status).toBe(404);
  });

  // ---- 3. rendering ----

  test("rendering: an agent's brief, an issue title and a deploy error are escaped everywhere they appear", async () => {
    const payload = `<script>alert(1)</script>&"'`;
    const escaped = "&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;";

    const agent = await createAgent(app, aliceUser(), {
      username: "xssbot",
      brief: payload,
    });
    expect(agent.ok).toBe(true);
    const crewPage = await bodyOf(alice, "/settings/crew");
    expect(crewPage).not.toContain(payload);
    expect(crewPage).toContain(escaped);

    const madeRepo = await createRepo(app, aliceUser(), {
      name: "xss-repo",
      visibility: "public",
    });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    const opened = await web(alice, "/alice/xss-repo/issues/new", {
      form: { title: payload, body: "" },
    });
    expect(opened.status).toBe(303);
    const assignedToAlice = await web(
      alice,
      "/alice/xss-repo/issues/1/assignee",
      {
        form: { assignee: "alice" },
      },
    );
    expect(assignedToAlice.status).toBe(303);
    const dash = await bodyOf(alice, "/feed");
    expect(dash).not.toContain(payload);
    expect(dash).toContain(escaped);

    // A deploy's error message is attacker-influenced too (it is the tail of
    // whatever the app's own install/build/health check printed).
    app.db
      .query(
        `INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, 'xss-repo', 'public', 'copy')`,
      )
      .run(id(), repo.id);
    const runId = id();
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, state, summary)
         VALUES (?1, ?2, 'deploy', 'production', 'failed', ?3)`,
      )
      .run(runId, repo.id, payload);
    const runPage = await bodyOf(alice, `/alice/xss-repo/runs/${runId}`);
    expect(runPage).not.toContain(payload);
    expect(runPage).toContain(escaped);
  });

  test("rendering: a run log survives script tags, closing </pre>, control bytes and a 16KB line", async () => {
    const madeRepo = await createRepo(app, aliceUser(), {
      name: "log-repo",
      visibility: "public",
    });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    const runId = id();
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, state) VALUES (?1, ?2, 'deploy', 'production', 'running')`,
      )
      .run(runId, repo.id);

    const huge = "x".repeat(20_000);
    const lines = [
      "<script>alert(document.cookie)</script>",
      "</pre><script>alert(2)</script>",
      "5 > 3 & 2 < 4",
      "forge_rw_abcdefghijklmnopqrstuvwxyz0123456789",
      "\x1b[31mred\x1b[0m and a bell \x07 and a null \x00",
      huge,
    ];
    for (const line of lines) appendRunLog(dataDir, runId, line);

    const page = await bodyOf(alice, `/alice/log-repo/runs/${runId}`);
    // The tags never appear unescaped — no live <script>, no early </pre>.
    expect(page).not.toContain("<script>alert(document.cookie)</script>");
    expect(page).not.toContain("</pre><script>");
    expect(page).toContain(
      "&lt;script&gt;alert(document.cookie)&lt;/script&gt;",
    );
    expect(page).toContain("5 &gt; 3 &amp; 2 &lt; 4");
    // A run log is stored with no embedded newline (appendRunLog collapses
    // one), and one appended write is one rendered line — the huge line does
    // not blow up the page or get silently dropped.
    expect(page).toContain(huge.slice(0, 100));
    // The token-shaped string is redacted on the way into the log (rule 6,
    // docs/APPS.md) — it must never reach the page verbatim, escaped or not.
    expect(page).not.toContain("forge_rw_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(page).toContain("[redacted]");
    // Exactly one log box — nothing in the log broke out of it.
    expect(page.match(/<div[^>]*id="run-log"/g)?.length).toBe(1);
  });

  // ---- 4. CSP ----

  test("CSP: the apps, runs and crew pages carry the same strict policy as the rest", async () => {
    for (const path of ["/apps", "/apps/new", "/settings/crew"]) {
      const response = await web(alice, path);
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(`${path}: ${csp}`).toContain("script-src 'self';");
      expect(csp).not.toContain("unsafe-inline");
      const body = await response.text();
      expect(csp).not.toContain("nonce");
      // Every *executable* <script> is a file on this origin — a
      // `type="application/json"` data island is inert and CSP's script-src
      // never gates it, so it is excluded rather than asserted on.
      const scripts = [...body.matchAll(/<script\b[^>]*>/g)].filter(
        ([tag]) => !/type="application\/json"/.test(tag),
      );
      expect(scripts.length).toBeGreaterThan(0);
      for (const [tag] of scripts) expect(tag).toMatch(/ src="\/assets\/[a-z]+-[0-9a-f]+\.js"/);
      // No inline event handler, no interpolated style attribute.
      expect(body).not.toMatch(/\son[a-z]+="/i);
    }
  });

  // ---- 5. N+1 ----

  test("N+1: /apps does not cost more queries as private, org-visible apps grow", async () => {
    const org = createOrg(app.db, "acme-apps", aliceUser().id);
    expect(org.ok).toBe(true);
    if (!org.ok) return;
    const team = createTeam(app.db, org.value.id, "readers", "read");
    expect(team.ok).toBe(true);
    if (!team.ok) return;
    const viewer = await createUser(app.db, { origin: "seed", trusted: true,
      username: "viewer1",
      email: "viewer1@forge.test",
      password: "viewer-pass-1234",
    });
    expect(viewer.ok).toBe(true);
    if (!viewer.ok) return;
    expect(addTeamMember(app.db, team.value, viewer.value.id)).toBe(true);
    const viewerCookie = await signUp("viewer1-cookie"); // unused path, just to reuse signUp's cookie header shape
    void viewerCookie;
    const cookie = await loginAs(base, "viewer1", "viewer-pass-1234");

    const seedApps = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const repoId = id();
        app.db
          .query(
            `INSERT INTO repo (id, owner_id, name, visibility, default_branch) VALUES (?1, ?2, ?3, 'private', 'main')`,
          )
          .run(repoId, org.value.id, `nplusone-${i}-${Date.now()}`);
        app.db
          .query(
            `INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, ?3, 'private', 'copy')`,
          )
          .run(id(), repoId, `nplusone-${i}-${id()}`.slice(0, 40));
      }
    };

    seedApps(5);
    // A session's first request stamps when it was last seen (once per
    // interval, `sessionUser`): one write per sign-in, not per row, so it
    // is spent before counting.
    await web(cookie, "/apps");
    const small = await statements(app.db, async () => {
      const response = await web(cookie, "/apps");
      expect(response.status).toBe(200);
    });
    seedApps(25); // 30 total now
    const large = await statements(app.db, async () => {
      const response = await web(cookie, "/apps");
      expect(response.status).toBe(200);
    });
    expect(large).toBe(small);
  });

  test("N+1: the dashboard's Apps and On-you cards stay flat with 30 apps and 30 assigned issues", async () => {
    const owner = await createUser(app.db, { origin: "seed", trusted: true,
      username: "dashowner",
      email: "dashowner@forge.test",
      password: "dashowner-pass-123",
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const org = createOrg(app.db, "acme-dash", owner.value.id);
    expect(org.ok).toBe(true);
    if (!org.ok) return;
    const team = createTeam(app.db, org.value.id, "readers", "read");
    expect(team.ok).toBe(true);
    if (!team.ok) return;
    const viewer = await createUser(app.db, { origin: "seed", trusted: true,
      username: "dashviewer",
      email: "dashviewer@forge.test",
      password: "dashviewer-pass-1",
    });
    expect(viewer.ok).toBe(true);
    if (!viewer.ok) return;
    expect(addTeamMember(app.db, team.value, viewer.value.id)).toBe(true);
    const cookie = await loginAs(base, "dashviewer", "dashviewer-pass-1");

    const seed = (n: number, offset: number): void => {
      for (let i = 0; i < n; i++) {
        const idx = offset + i;
        const repoId = id();
        app.db
          .query(
            `INSERT INTO repo (id, owner_id, name, visibility, default_branch) VALUES (?1, ?2, ?3, 'private', 'main')`,
          )
          .run(repoId, org.value.id, `dash-${idx}-${Date.now()}`);
        app.db
          .query(
            `INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, ?3, 'private', 'copy')`,
          )
          .run(id(), repoId, `dash-${idx}-${id()}`.slice(0, 40));
        const assignedIssue = id();
        app.db
          .query(
            `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, assignee_id)
             VALUES (?1, ?2, 1, 'issue', ?3, '', ?4, 'open', ?5)`,
          )
          .run(
            assignedIssue,
            repoId,
            `assigned ${idx}`,
            owner.value.id,
            viewer.value.id,
          );
      }
    };

    seed(5, 0);
    // A session's first request stamps when it was last seen (once per
    // interval, `sessionUser`): one write per sign-in, not per row, so it
    // is spent before counting.
    await web(cookie, "/");
    const small = await statements(app.db, async () => {
      const response = await web(cookie, "/");
      expect(response.status).toBe(200);
    });
    seed(25, 5); // 30 total of each
    const large = await statements(app.db, async () => {
      const response = await web(cookie, "/");
      expect(response.status).toBe(200);
    });
    expect(large).toBe(small);
  });

  // KNOWN LIMITATION, out of this file's scope: `needsYouCard` (site.ts)
  // still calls `canWrite` once per *distinct* repository among the crew's
  // open pulls. Write access is answered for all of them by one
  // `writableRepoIds` query (`REPO_WRITABLE`, the SQL twin of `canWrite`),
  // so the count must not move with the number of distinct repositories.
  test("N+1: needsYouCard does not cost more as agent pulls span more distinct repos", async () => {
    const owner = await createUser(app.db, { origin: "seed", trusted: true,
      username: "needsowner",
      email: "needsowner@forge.test",
      password: "needsowner-pass-1",
    });
    if (!owner.ok) return;
    const org = createOrg(app.db, "acme-needs", owner.value.id);
    if (!org.ok) return;
    const team = createTeam(app.db, org.value.id, "writers", "write");
    if (!team.ok) return;
    const viewer = await createUser(app.db, { origin: "seed", trusted: true,
      username: "needsviewer",
      email: "needsviewer@forge.test",
      password: "needsviewer-pass-1",
    });
    if (!viewer.ok) return;
    addTeamMember(app.db, team.value, viewer.value.id);
    const agent = await createAgent(app, aliceUser(), {
      username: "needsbot",
    });
    if (!agent.ok) return;
    const cookie = await loginAs(base, "needsviewer", "needsviewer-pass-1");

    const seed = (n: number, offset: number): void => {
      for (let i = 0; i < n; i++) {
        const idx = offset + i;
        const repoId = id();
        app.db
          .query(
            `INSERT INTO repo (id, owner_id, name, visibility, default_branch) VALUES (?1, ?2, ?3, 'private', 'main')`,
          )
          .run(repoId, org.value.id, `needs-${idx}-${Date.now()}`);
        app.db
          .query(
            `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
             VALUES (?1, ?2, 1, 'pull', ?3, '', ?4, 'open')`,
          )
          .run(id(), repoId, `agent pull ${idx}`, agent.value.user.id);
      }
    };

    seed(5, 0);
    // A session's first request stamps when it was last seen (once per
    // interval, `sessionUser`): one write per sign-in, not per row, so it
    // is spent before counting.
    await web(cookie, "/");
    const small = await statements(app.db, async () => {
      await web(cookie, "/");
    });
    seed(25, 5);
    const large = await statements(app.db, async () => {
      await web(cookie, "/");
    });
    expect(large).toBe(small);
  });

  test("N+1: the runs list does not cost more at 50 rows than at 5", async () => {
    const madeRepo = await createRepo(app, aliceUser(), {
      name: "runs-n1",
      visibility: "public",
    });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    const seedRuns = (n: number): void => {
      for (let i = 0; i < n; i++) {
        app.db
          .query(
            `INSERT INTO run (id, repo_id, kind, env, state, summary) VALUES (?1, ?2, 'deploy', 'production', 'ok', 'ok')`,
          )
          .run(id(), repo.id);
      }
    };
    seedRuns(5);
    const small = await statements(app.db, async () => {
      const response = await web(alice, "/alice/runs-n1/runs");
      expect(response.status).toBe(200);
    });
    seedRuns(45); // 50 total
    const large = await statements(app.db, async () => {
      const response = await web(alice, "/alice/runs-n1/runs");
      expect(response.status).toBe(200);
    });
    expect(large).toBe(small);
  });

  test("N+1: a pull's crew activity does not cost more as its agent runs grow", async () => {
    const agent = await createAgent(app, aliceUser(), {
      username: "crewn1bot",
    });
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;
    const madeRepo = await createRepo(app, aliceUser(), {
      name: "crew-n1",
      visibility: "public",
    });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    // The default branch needs a commit of its own before another branch
    // can be based on it — an empty repo has no `main` to diff against yet.
    const seeded = await commitToBranch(app, aliceUser(), repo, {
      message: "first",
      files: [{ path: "README.md", content: "# crew-n1\n" }],
    });
    expect(seeded.ok).toBe(true);
    const committed = await commitToBranch(app, aliceUser(), repo, {
      branch: "work",
      base: repo.defaultBranch,
      message: "work",
      files: [{ path: "A.md", content: "a\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, aliceUser(), repo, {
      title: "Crew N+1",
      baseBranch: repo.defaultBranch,
      headBranch: "work",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const issueRow = app.db
      .query<
        { id: string },
        [string, number]
      >("SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2")
      .get(repo.id, opened.value.number)!;

    const seedActivity = (n: number): void => {
      for (let i = 0; i < n; i++) {
        app.db
          .query(
            `INSERT INTO run (id, repo_id, kind, issue_id, env, state, actor_id, summary)
             VALUES (?1, ?2, 'agent', ?3, '', 'ok', ?4, 'did a thing')`,
          )
          .run(id(), repo.id, issueRow.id, agent.value.user.id);
      }
    };

    seedActivity(3);
    const small = await statements(app.db, async () => {
      const response = await web(
        alice,
        `/alice/crew-n1/pulls/${opened.value.number}`,
      );
      expect(response.status).toBe(200);
    });
    seedActivity(20);
    const large = await statements(app.db, async () => {
      const response = await web(
        alice,
        `/alice/crew-n1/pulls/${opened.value.number}`,
      );
      expect(response.status).toBe(200);
    });
    expect(large).toBe(small);
  });

  // ---- 6. mobile ----

  test("mobile: the apps/runs/crew CSS carries no fixed width that forces horizontal scroll at 320px", () => {
    const marker = "/* ---- apps, runs, and the crew ---- */";
    const start = contentStyle.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = contentStyle.indexOf(
      "/* ---- proposing a change ---- */",
      start,
    );
    const block = contentStyle.slice(start, end === -1 ? undefined : end);
    // Any px width at or above ~320 would itself force a phone to scroll
    // sideways; small fixed sizes (icon slots, borders) are fine, and so is
    // a max-width or a media query, which only ever narrows.
    const wide = [
      ...block.matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g),
    ].filter(([, n]) => Number(n) >= 300);
    expect(wide).toEqual([]);
  });

  function aliceUser(): User {
    return getUserByName(app.db, "alice")!;
  }
});

/** Sign in over the API and return the session cookie's `cookie:` value. */
async function loginAs(
  base: string,
  username: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${base}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
  return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
}

// ============================================================================
// TUI
// ============================================================================

describe("surfaces adversarial: tui", () => {
  let dataDir = "";
  let forge: Forge;
  let alice: User;
  let hello: Repo;

  const identityFor = (user?: User): TuiIdentity => ({
    sshUsername: user?.username ?? "guest",
    remoteAddress: "127.0.0.1",
    fingerprint: `SHA256:${user?.username ?? "guest"}`,
    ...(user === undefined ? {} : { user }),
  });

  function boot(identity: TuiIdentity, cols = 140, rows = 44) {
    const terminal = headlessTerminal(cols, rows);
    const { app, session } = createForgeApp(forge, identity, {
      terminal,
      exitHooks: false,
    });
    app.start();
    const settle = (): Promise<void> => settleApp(app);
    const one = async (key: string): Promise<void> => {
      const ctrl = key.startsWith("ctrl+");
      app.dispatch({
        type: "key",
        key: ctrl ? key.slice(5) : key,
        ctrl,
        alt: false,
        shift: false,
      });
      await settle();
    };
    return {
      app,
      session,
      terminal,
      text: () => app.screen.toText(),
      async press(...keys: string[]) {
        for (const key of keys) await one(key);
      },
      async push(make: (s: Session, ctx: TuiApp["ctx"]) => Screen) {
        app.ctx.push(make(session, app.ctx));
        await settle();
      },
      pop() {
        app.ctx.pop();
      },
      settle,
      async until(what: string, ms = 15_000) {
        const deadline = Date.now() + ms;
        for (;;) {
          await settle();
          if (app.screen.toText().includes(what)) return;
          if (Date.now() > deadline)
            throw new Error(
              `never saw ${JSON.stringify(what)} on screen:\n${app.screen.toText()}`,
            );
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-surfaces-adv-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await createUser(forge.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(forge, alice, {
      name: "hello",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    hello = made.value;
    const committed = await commitToBranch(forge, alice, made.value, {
      message: "first",
      files: [{ path: "README.md", content: "# hello\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  }, 30_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a guest cannot assign an issue: the issue screen never wires `a`", async () => {
    const { openIssue, assignIssue } = await import("../src/actions/issues.ts");
    const { issueScreen } = await import("../src/tui/screens/issue.ts");
    const { local } = await import("../src/tui/screens/where.ts");
    const opened = await openIssue(forge, alice, hello, {
      title: "Guest cannot touch this",
      body: "",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const h = boot(identityFor(undefined));
    try {
      await h.push((s, ctx) =>
        issueScreen(s, ctx, local(s, hello), opened.value.number),
      );
      await h.until("Guest cannot touch this");
      const before = h.text();
      await h.press("a");
      // No picker opened: the screen only wires `a` for a writer.
      expect(h.text()).toBe(before);
      expect(h.text()).not.toContain("Assign #");
      // Defense in depth: even if something did reach the action, a guest
      // actor is refused there too.
      const refused = assignIssue(forge, undefined, hello, opened.value, alice);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toBe("unauthorized");
    } finally {
      h.stop();
    }
  }, 30_000);

  test("a screen popped while its load is in flight renders and toasts nothing afterward", async () => {
    const h = boot(identityFor(alice));
    try {
      // Push and immediately pop, before the load's promise has settled.
      h.app.ctx.push(
        issuesScreen(h.session, h.app.ctx, local(h.session, hello), "issue"),
      );
      h.pop();
      await h.settle();
      // The forge is back where it was; nothing threw, nothing left a toast
      // meant for a screen nobody can see any more.
      expect(h.text()).not.toContain("undefined");
    } finally {
      h.stop();
    }
  }, 30_000);
});
