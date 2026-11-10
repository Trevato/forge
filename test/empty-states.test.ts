/** A fresh account's blank list pages are never a dead end: every empty state carries a link (#10938). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-empty-states-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "root", allowReserved: true, email: "root@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
  const made = await createRepo(app, u.value, { name: "fresh", visibility: "public" });
  if (!made.ok) throw new Error("repo");
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const LISTS = ["/root/fresh/issues", "/root/fresh/pulls", "/root/fresh/runs", "/apps", "/settings/people", "/boards", "/notes"];

/** Every `.empty` block in a page, whole: matched by div depth, so a nested
 * div in the part never cuts it short. */
function emptyBlocks(page: string): string[] {
  const out: string[] = [];
  let at = page.indexOf('<div class="empty">');
  while (at !== -1) {
    const tag = /<(\/?)div\b/g;
    tag.lastIndex = at;
    let depth = 0;
    let end = page.length;
    for (let m = tag.exec(page); m; m = tag.exec(page)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = page.indexOf(">", m.index) + 1;
        break;
      }
    }
    out.push(page.slice(at, end));
    at = page.indexOf('<div class="empty">', end);
  }
  return out;
}

const links = (block: string): string[] => [...block.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}|${m[2]!.trim()}`);

for (const path of LISTS) {
  test(`${path}: a fresh account's empty state has a link`, async () => {
    const res = await fetch(servers.url + path, { headers: { cookie } });
    const blocks = emptyBlocks(await res.text());
    const bare = blocks.filter((b) => links(b).length === 0);
    expect(bare).toEqual([]);
  });
}

const REPO_LISTS = ["issues", "pulls", "runs"];
for (const list of REPO_LISTS) {
  test(`/root/fresh/${list}: signed out, the empty state still has one link`, async () => {
    const blocks = emptyBlocks(await (await fetch(`${servers.url}/root/fresh/${list}`)).text());
    expect(blocks.length).toBe(1);
    expect(links(blocks[0]!).length).toBe(1);
  });
  test(`/root/fresh/${list}?word=shipped: a filtered empty state links back to the whole list`, async () => {
    for (const headers of [{ cookie }, {}]) {
      const blocks = emptyBlocks(await (await fetch(`${servers.url}/root/fresh/${list}?word=shipped`, { headers })).text());
      expect(blocks.length).toBe(1);
      expect(links(blocks[0]!)).toEqual([`/root/fresh/${list}|Show all`]);
    }
  });
}

test("each list's one link says its own next step, in one sentence", async () => {
  const one = async (list: string, headers: Record<string, string>) => {
    const [b] = emptyBlocks(await (await fetch(`${servers.url}/root/fresh/${list}`, { headers })).text());
    return links(b!);
  };
  expect(await one("issues", { cookie })).toEqual(["/root/fresh/issues/new|Tell the crew"]);
  expect(await one("issues", {})).toEqual(["/signin?next=%2Froot%2Ffresh%2Fissues|Sign in"]);
  expect(await one("pulls", { cookie })).toEqual(["/root/fresh/issues|See open issues"]);
  expect(await one("runs", { cookie })).toEqual(["/root/fresh/issues|Start with an issue"]);
  const [b] = emptyBlocks(await (await fetch(`${servers.url}/root/fresh/pulls`, { headers: { cookie } })).text());
  expect(b).not.toContain("Tell the crew");
  expect((b!.match(/<p\b/g) ?? []).length).toBe(1);
});
