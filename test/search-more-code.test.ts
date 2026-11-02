/** The search page offers the code it skipped, and `?code=all` runs it (#3385). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

interface Site {
  dir: string;
  app: ReturnType<typeof createApp>;
  servers: Awaited<ReturnType<typeof serve>>;
}

/** An app with six public repositories that all hold "zebrafish". */
async function site(codeBudgetMs: number): Promise<Site> {
  const dir = await mkdtemp(join(tmpdir(), "forge-search-more-"));
  const app = createApp({ dataDir: dir, port: 0, codeBudgetMs });
  const servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const bearer = createToken(app.db, made.value.id, "t", "admin").token;
  const api = (path: string, body: unknown) =>
    fetch(servers.url + path, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (let i = 0; i < 6; i++) {
    await api("/api/v1/repos", { name: `r${i}`, visibility: "public" });
    await api(`/api/v1/repos/alice/r${i}/contents`, {
      branch: "main", message: "c", files: [{ path: "a.txt", content: "zebrafish\n" }],
    });
  }
  return { dir, app, servers };
}

let spent: Site;
let roomy: Site;

beforeAll(async () => {
  spent = await site(0);
  roomy = await site(60_000);
}, 120_000);

afterAll(async () => {
  for (const s of [spent, roomy]) {
    s.servers.stop();
    s.app.close();
    await rm(s.dir, { recursive: true, force: true });
  }
});

const page = async (site: Site, qs: string) =>
  (await fetch(`${site.servers.url}/search?${qs}`)).text();
const rowsOf = (html: string) => (html.match(/class="row code-hit"/g) ?? []).length;

test("a spent budget shows what it has and one link that runs the rest", async () => {
  const html = await page(spent, "q=zebrafish&live=1");
  expect(rowsOf(html)).toBe(4);
  expect(html.match(/data-more-code/g)?.length).toBe(1);
  const href = /<a href="([^"]+)">More code results/.exec(html)![1]!.replaceAll("&amp;", "&");
  expect(href).toBe("/search?q=zebrafish&live=1&code=all#code");
  // The note sits inside the code section, after its rows.
  expect(html.indexOf("data-more-code")).toBeGreaterThan(html.lastIndexOf('class="row code-hit"'));

  const all = await page(spent, href.slice("/search?".length).replace(/#.*/, ""));
  expect(rowsOf(all)).toBe(6);
  expect(all).not.toContain("data-more-code");
});

test("the link keeps the kind it was asked for", async () => {
  const html = await page(spent, "q=zebrafish&kind=code");
  expect(html).toContain("/search?q=zebrafish&amp;kind=code&amp;code=all#code");
});

test("a roomy budget shows every row and offers nothing more", async () => {
  const html = await page(roomy, "q=zebrafish&live=1");
  expect(rowsOf(html)).toBe(6);
  expect(html).not.toContain("data-more-code");
});

test("a search with no hits in any kind says so once and offers Explore", async () => {
  const html = await page(roomy, "q=qqqxnothingmatchesqqq");
  expect(html).not.toContain("no-hits");
  expect(html).toContain("Nothing matches “qqqxnothingmatchesqqq”");
  expect(html).toContain("code you can see");
  expect(html).toContain('href="/explore"');
  expect(html).not.toContain("No app or repository matches");
  expect(html).not.toContain('id="repos"');
  expect(html).not.toContain('id="code"');
});

test("the empty state escapes the query", async () => {
  const html = await page(roomy, "q=" + encodeURIComponent("<b>qqzz</b>"));
  expect(html).toContain("Nothing matches “&lt;b&gt;qqzz&lt;/b&gt;”");
  expect(html).not.toContain("<b>qqzz</b>");
});

test("a narrowed kind with no match keeps its empty state and offers everything", async () => {
  const html = await page(roomy, "q=qqqxnothingmatchesqqq&kind=code");
  expect(html).toContain("No line of code matches");
  expect(html).not.toContain("Nothing matches");
  expect(html).toContain('href="/search?q=qqqxnothingmatchesqqq"');
  expect(html).toContain("Search everything");
});

test("one result in any kind keeps the sections", async () => {
  const html = await page(roomy, "q=zebrafish");
  expect(html).not.toContain("Nothing matches");
  expect(html).toContain('id="repos"');
  expect(html).toContain("No app or repository matches");
  expect(html).toContain('id="code"');
});
