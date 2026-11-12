/** The home as the eye reads it (#5765): the cold read of #5735 starts from this text. */
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
import { pageText } from "../src/web/page_text.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-page-text-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "keeper",
    email: "keeper@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  promote(app.db, r.value);
  cookie = `forge_session=${createSession(app.db, r.value.id).token}; forge_mode=studio`;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string) => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("the real home reads as text: heading and waiting count, no CSS, script or tag", async () => {
  const owner = app.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id;
  const repo = await createRepoRow(app.db, app.reposRoot, { ownerId: owner, name: "wait", visibility: "public", description: "wait" });
  if (!repo.ok) throw new Error(repo.error);
  for (const [i, h] of [30, 40, 50].entries()) {
    const issueId = id();
    const number = app.db.query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq").get(repo.value.id)!.issue_seq;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`)
      .run(issueId, repo.value.id, number, `Stale ${i}`, owner, new Date(Date.now() - h * 3_600_000).toISOString());
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
      .run(issueId, `b/${i}`, "0".repeat(40), repo.value.id);
  }
  const raw = await get("/feed");
  expect(raw).toContain("<script");
  expect(raw).toContain("<style");
  const text = pageText(raw);
  expect(text).toContain("Feed Your apps Asked");
  expect(text).toMatch(/3 waiting on you, oldest 5\d h/);
  expect(text).not.toMatch(/<\/?[a-z]/i);
  expect(text).not.toMatch(/[{};]\s*$|:root|@media|function\s*\(|=>|var\(--/m);
  expect(text.length).toBeLessThan(raw.length / 2);
});

test("entities decode; hidden, template, script, style and head blocks are dropped; link text stays", () => {
  const html = `<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body>
    <script>var x = "</div> shown?";</script>
    <h1>Tom &amp; Jerry &lt;3 &#x41;&#66;&nbsp;&middot;</h1>
    <p>See <a href="/x">the <b>bold</b> link</a>, ok.</p>
    <div hidden>secret <div>nested</div> still secret</div>
    <div aria-hidden="true"><span>icon</span><script>"</div>"</script> gone</div>
    <div aria-hidden="false">kept</div>
    <template><p>tpl</p></template>
    <ul><li>one</li><li>two   words</li></ul><!-- comment --></body></html>`;
  const text = pageText(html);
  expect(text).toBe("Tom & Jerry <3 AB ·\nSee the bold link, ok.\nkept\none\ntwo words");
});

const run = async (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn(["bun", "scripts/home-read.ts", ...args], {
    env: { ...process.env, FORGE_COOKIE: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
};

test("scripts/home-read.ts prints the text and the stats line, sends FORGE_COOKIE and never prints it", async () => {
  const r = await run([`${servers.url}/feed`], { FORGE_COOKIE: cookie });
  expect(r.code).toBe(0);
  expect(r.out.trimEnd().split("\n").pop()).toMatch(/^chars \d+ · words \d+ · fetched in \d+ ms$/);
  expect(r.out).toContain("Feed Your apps Asked");
  const token = cookie.match(/forge_session=([^;]+)/)![1]!;
  expect(r.out).not.toContain(token);
  expect(r.err).not.toContain(token);
});

test("scripts/home-read.ts exits 1 on a non-200 and 2 on a non-http argument", async () => {
  const denied = await run([`${servers.url}/admin`]);
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("answered");
  expect((await run(["file:///etc/passwd"])).code).toBe(2);
  expect((await run([])).code).toBe(2);
});

test("`hidden` inside another attribute's value does not hide; only a real attribute does", () => {
  const html = `<p class="x hidden y">class kept</p><a title="a hidden gem" href="/g">title kept</a>
    <p data-x='aria-hidden="true"'>data kept</p><p hidden="false">false kept</p>
    <p class="a" hidden>gone</p><p title="t" aria-hidden='true'>gone too</p><p HIDDEN="">gone three</p>`;
  expect(pageText(html)).toBe("class kept\ntitle kept\ndata kept\nfalse kept");
});
