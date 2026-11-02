/** The owner's home scored against ground truth (#5805). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createRepo as createRepoRow } from "../src/core/repos.ts";
import { id } from "../src/kernel/id.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { coverage, errors, scoreHome, type Truth } from "../src/system/home_eval.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-home-eval-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "keeper", email: "keeper@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  promote(app.db, r.value);
  cookie = `forge_session=${createSession(app.db, r.value.id).token}; forge_mode=studio`;
  const owner = r.value.id;
  const repo = await createRepoRow(app.db, app.reposRoot, { ownerId: owner, name: "wait", visibility: "public", description: "wait" });
  if (!repo.ok) throw new Error(repo.error);
  for (const i of [0, 1, 2]) {
    const issueId = id();
    const number = app.db.query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq").get(repo.value.id)!.issue_seq;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`)
      .run(issueId, repo.value.id, number, `Stale ${i}`, owner, new Date(Date.now() - 40 * 3_600_000).toISOString());
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
      .run(issueId, `b/${i}`, "0".repeat(40), repo.value.id);
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

let stub: ReturnType<typeof Bun.serve> | undefined;
afterAll(() => stub?.stop(true));

const run = async (args: string[]) => {
  const proc = Bun.spawn(["bun", "scripts/home-eval.ts", ...args], { env: { ...process.env, FORGE_COOKIE: cookie, FORGE_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
};

test("scoreHome marks a wrong waiting count wrong and the rest stated", async () => {
  const truth = (await (await fetch(`${servers.url}/api/v1/telemetry/home`, { headers: { cookie } })).json()) as { waiting: { count: number } };
  expect(truth.waiting.count).toBe(3);
  // The page as it should read, then the same page with the count wrong.
  const page = `3 changes in 24 h\nCrew spend today $0.00 no ceiling\nBuilders running —\nNo slots set\n3 waiting on you, oldest 40 h`;
  const t: Truth = { landed: 3, live: null, builders: { running: 0, slots: 0, idle: "no slots set" }, spend: { todayUsd: 0, ceilingUsd: null }, waiting: { count: 3 }, repos: [], quiet: [] };
  const good = scoreHome(page, t);
  expect(good.map((f) => f.verdict)).toEqual(["stated", "stated", "stated", "stated", "stated"]);
  const bad = scoreHome(page.replace("3 waiting", "5 waiting"), t);
  expect(bad.find((f) => f.key === "waiting")).toMatchObject({ verdict: "wrong", words: "5 waiting on you, oldest 40 h" });
  expect(errors(bad)).toBe(1);
  expect(coverage(bad)).toBe(4);
});

test("scripts/home-eval.ts prints a verdict per fact with the page's words, then coverage, errors, characters and fetch time", async () => {
  const r = await run([servers.url]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const lines = r.out.trimEnd().split("\n");
  expect(lines.filter((l) => /^(stated|missing|wrong) /.test(l))).toHaveLength(5);
  expect(r.out).toContain("3 waiting on you");
  expect(lines.at(-1)).toMatch(/^coverage \d of 5 · errors \d · chars \d+ · fetched in \d+ ms$/);
  expect(r.out).not.toContain(cookie.match(/forge_session=([^;]+)/)![1]!);
});

test("the real home never contradicts its own figures; with one figure changed in front of it, the script says wrong", async () => {
  const honest = await run([servers.url]);
  expect(honest.out).toMatch(/errors 0 ·/);
  expect(honest.out).not.toMatch(/^wrong /m);
  const home = await (await fetch(`${servers.url}/feed`, { headers: { cookie } })).text();
  expect(home).toContain("3 waiting on you");
  // A stand-in in front of the forge: the real home with one figure wrong, every API read passed through.
  stub = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/") return new Response(home.replace("3 waiting on you", "5 waiting on you"), { headers: { "content-type": "text/html" } });
      return fetch(`${servers.url}${u.pathname}${u.search}`, { headers: { cookie } });
    },
  });
  const lied = await run([`http://127.0.0.1:${stub.port}`]);
  expect(lied.code).toBe(0);
  expect(lied.out).toMatch(/^wrong\s+waiting on the owner$/m);
  expect(lied.out).toContain("5 waiting on you");
  expect(lied.out).toMatch(/errors 1 ·/);
});

test("a ceiling the page hides, a quiet repo it blames wrongly and an unnamed idle reason are scored", () => {
  const t: Truth = {
    landed: 1,
    live: { sha: "abcdef0123" },
    builders: { running: 0, slots: 2, idle: "daily ceiling of $600 reached" },
    spend: { todayUsd: 601, ceilingUsd: 600 },
    waiting: { count: 0 },
    repos: ["a/old", "a/new"],
    quiet: ["a/old"],
  };
  const page = "1 change in 24 h\nLive version abcdef0\nBuilders running 0 of 2\nrunning now\nCrew spend today $601 no ceiling\na/new has no commit since Friday";
  const f = Object.fromEntries(scoreHome(page, t).map((x) => [x.key, x.verdict]));
  expect(f).toEqual({ landed: "stated", waiting: "stated", builders: "missing", spend: "wrong", quiet: "wrong" });
  expect(scoreHome("nothing", t).find((x) => x.key === "landed")?.verdict).toBe("missing");
});

test("scripts/home-eval.ts exits 2 on a non-http argument and 1 when the page will not answer", async () => {
  expect((await run(["file:///etc/passwd"])).code).toBe(2);
  const denied = await run([`${servers.url}/nope`]);
  expect(denied.code).toBe(1);
});
