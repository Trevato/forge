/** /flow's clog section (#11454): the sentence, the shared red test, the pull pairs — each on the page's HTML; quiet draws nothing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { rememberPullFiles } from "../src/crew/hot_files.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";
let aliceId = "";
let n = 0;

const page = async () => (await fetch(`${servers.url}/flow`, { headers: { cookie } })).text();
const pull = (): number => {
  const issueId = id();
  n += 1;
  const num = 200 + n;
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'open')`)
    .run(issueId, repoId, num, aliceId);
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, '', ?3, ?4)`)
    .run(issueId, `br-${String(n)}`, `oid-${String(n)}`, repoId);
  return num;
};
const red = (num: number, names: string[]) => {
  const issue = app.db.query<{ id: string }, [number]>("SELECT id FROM issue WHERE number = ?1").get(num)!;
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, state, check_detail) VALUES (?1, ?2, 'check', ?3, 'failed', ?4)`)
    .run(id(), repoId, issue.id, JSON.stringify({ names }));
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-clogpage-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const alice = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  aliceId = alice.id;
  repoId = must(await createRepo(app, alice, { name: "app", visibility: "public" })).id;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}, 60_000);

afterAll(async () => {
  rememberPullFiles(repoId, []);
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a quiet lane draws no clog rows", async () => {
  expect(await page()).not.toContain('id="flow-clog"');
});

test("a test failing on three open pulls is shown once with its pulls linked; two is not", async () => {
  const [a, b, c, d] = [pull(), pull(), pull(), pull()];
  for (const p of [a, b, c]) red(p, ["shared > breaks", "own " + String(p)]);
  red(d, ["two > only"]);
  red(a, ["two > only"]); // a's latest check is now this one, so it drops from "shared > breaks"
  let html = await page();
  expect(html).not.toContain("flow-shared-red");
  red(a, ["shared > breaks"]);
  html = await page();
  expect(html).toContain('id="flow-shared-red"');
  expect(html.split("shared &gt; breaks").length - 1).toBe(1);
  for (const p of [a, b, c]) expect(html).toContain(`/alice/app/pulls/${String(p)}`);
  expect(html).toContain("fails on 3 open pulls");
});

test("pulls touching the same files are listed as a pair, linked to both, and the sentence names the hottest file", async () => {
  const [x, y, z] = [pull(), pull(), pull()];
  rememberPullFiles(repoId, [
    { number: x, files: ["src/a.ts", "src/b.ts"] },
    { number: y, files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
    { number: z, files: ["src/a.ts"] },
  ]);
  const html = await page();
  expect(html).toContain('id="flow-conflict-pairs"');
  expect(html).toContain(`/alice/app/pulls/${String(x)}`);
  expect(html).toContain(`/alice/app/pulls/${String(y)}`);
  expect(html).toContain("2 shared files");
  expect(html).toContain("1 shared file<");
  expect(html).toContain('id="clog-says"');
  expect(html).toContain("3 open pulls touch src/a.ts");
});

test("the bottleneck sentence appears when approved pulls conflict", async () => {
  const p = pull();
  const issue = app.db.query<{ id: string }, [number]>("SELECT id FROM issue WHERE number = ?1").get(p)!;
  app.db.query(`INSERT INTO review (id, issue_id, author_id, state) VALUES (?1, ?2, ?3, 'approved')`).run(id(), issue.id, aliceId);
  app.db.query(`INSERT INTO run (id, repo_id, kind, issue_id, state, reason) VALUES (?1, ?2, 'agent', ?3, 'queued', 'conflict')`).run(id(), repoId, issue.id);
  expect(await page()).toContain("1 approved pull conflicts");
});

test("the terminal's Flow dialog says the same: the sentence, the shared test and the pairs; an agent's does not", () => {
  const lines = flowLines(app.db).join("\n").replace(/\s*\n/g, " ");
  expect(lines).toContain("shared > breaks fails on 3 open pulls");
  expect(lines).toContain("shared files");
  expect(lines).toContain("3 open pulls touch src/a.ts");
  expect(flowLines(app.db, new Date(), undefined, { queues: [] }).join("\n")).not.toContain("fails on 3 open pulls");
});
