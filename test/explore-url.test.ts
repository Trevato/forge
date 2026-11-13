/** The explorer's filters are URL parameters (#10727): a filtered view is a link that reloads the same. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { exploreLineFrom, exploreParams, readExploreLine } from "../src/actions/explore.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { promote } from "./helpers/members.ts";

quietLogs();
let dir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-explore-url-"));
  app = createApp({ dataDir: dir, port: 0 });
  for (const [owner, names] of [["olive", ["garden", "kiln"]], ["pine", ["loom"]]] as const) {
    const made = await createUser(app.db, { origin: "seed", username: owner, email: `${owner}@forge.local`, password: "a-good-passphrase", adminIfFirst: false });
    if (!made.ok) throw new Error(made.error);
    proveAll(app);
    promote(app.db, made.value);
    for (const n of names) {
      const repo = await createRepo(app, made.value, { name: n, visibility: "public" });
      if (!repo.ok) throw new Error(String(repo.error));
      const rec = insertApp(app.db, { repoId: repo.value.id, slug: `${owner}-${n}`, access: "public" });
      if (!rec.ok) throw new Error(rec.error);
    }
  }
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop();
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const page = async (qs: string) => {
  const res = await fetch(`${servers.url}/explore${qs}`);
  return { status: res.status, html: await res.text() };
};
const listed = (html: string): string[] => {
  const list = /<ul class="list">([\s\S]*?)<\/ul>/.exec(html);
  return list === null ? [] : [...list[1]!.matchAll(/<li[^>]*>[\s\S]*?<a href="(\/[^"?]*)">/g)].map((m) => m[1]!);
};

test("two filtered URLs give different, correct result sets, and a reload equals the first load", async () => {
  const mine = await page("?kind=app&owner=olive&sort=name");
  const theirs = await page("?kind=app&owner=pine");
  expect(listed(mine.html)).toEqual(["/olive/garden", "/olive/kiln"]);
  expect(listed(theirs.html)).toEqual(["/pine/loom"]);
  expect((await page("?kind=app&owner=olive&sort=name")).html).toBe(mine.html);
  const people = await page("?kind=person");
  expect(listed(people.html).sort()).toEqual(["/olive", "/pine"]);
});

test("the API and the page answer the same for separate parameters and for the line", async () => {
  const a = (await (await fetch(`${servers.url}/api/v1/explore?kind=app&owner=pine`)).json()) as { items: { url: string }[] };
  const b = (await (await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent("kind:app owner:pine")}`)).json()) as { items: { url: string }[] };
  expect(a.items.map((i) => i.url)).toEqual(["/pine/loom"]);
  expect(b.items).toEqual(a.items);
});

test("an unknown parameter is ignored; an invalid value is named and the default shown", async () => {
  const plain = await page("");
  const extra = await page("?utm=1&zzz=2");
  expect(extra.status).toBe(200);
  expect(listed(extra.html)).toEqual(listed(plain.html));
  const bad = await page("?sort=bogus");
  expect(bad.status).toBe(200);
  expect(listed(bad.html)).toEqual(listed(plain.html));
});

test("an unknown kind, sort or updated is a 200 with a plain note and the unfiltered list, escaped (#11819)", async () => {
  const plain = listed((await page("")).html);
  for (const qs of ["?kind=bogus", "?sort=bogus", "?updated=9y", "?since=9y", `?kind=${encodeURIComponent("<script>x</script>")}`]) {
    const res = await page(qs);
    expect(res.status).toBe(200);
    expect(res.html).toContain('role="status"');
    expect(res.html).toMatch(/is not a (kind|sort|window)/);
    expect(res.html).not.toContain("<script>x</script>");
    expect(listed(res.html)).toEqual(plain);
  }
});

test("a value is one word and is escaped", async () => {
  expect(exploreLineFrom((n) => (n === "kind" ? "app garden" : undefined))).toBe("kind:appgarden");
  expect(readExploreLine(exploreLineFrom((n) => (n === "owner" ? "<script>" : undefined))).unknown).toEqual(["owner:<script>"]);
  const res = await page(`?owner=${encodeURIComponent('"><script>x</script>')}`);
  expect(res.html).not.toContain("<script>x</script>");
});

test("the chips link with separate parameters", async () => {
  const { html } = await page("");
  expect(html).toContain('href="/explore?kind=app"');
  expect(html).toContain('href="/explore?sort=forks"');
  expect(exploreParams(readExploreLine("kind:app sort:forks owner:olive garden").query)).toBe("kind=app&sort=forks&owner=olive&q=garden");
});

test("`since` is the `updated` window: same line, bad value is a noted 200 (#11232)", async () => {
  expect(exploreLineFrom((n) => (n === "since" ? "7d" : null))).toBe("updated:7d");
  expect(exploreLineFrom((n) => (n === "since" ? "9y" : null))).toBe("updated:9y");
  const ok = await fetch(`${servers.url}/explore?kind=app&since=7d`);
  expect(ok.status).toBe(200);
  const bad = await fetch(`${servers.url}/explore?since=9y`);
  expect(bad.status).toBe(200);
  expect(await bad.text()).toContain("1d, 7d, 30d");
});

test("each kind and each since narrows the list, and the filtered view costs few statements (#11232)", async () => {
  const all = listed((await page("")).html);
  expect(all.length).toBeGreaterThan(0);
  const apps = listed((await page("?kind=app")).html);
  const people = listed((await page("?kind=person")).html);
  expect(apps.length).toBeGreaterThan(0);
  expect(people.length).toBeGreaterThan(0);
  expect(apps).not.toEqual(people);
  expect(apps.length).toBeLessThan(all.length);
  expect(people.length).toBeLessThan(all.length);
  // Forges are an admin's to see: a visitor's `kind=forge` is a different (empty) list.
  const forges = await page("?kind=forge");
  expect(forges.status).toBe(200);
  expect(listed(forges.html)).toEqual([]);
  // Nothing here has shipped, so each window drops what the bare list shows.
  for (const since of ["7d", "30d"]) {
    const res = await page(`?since=${since}`);
    expect(res.status).toBe(200);
    expect(listed(res.html).length).toBeLessThan(all.length);
  }
  for (const qs of ["?kind=app&since=7d", "?kind=person&since=30d", "?kind=forge"]) {
    expectWork(await requestStatements(app.db, `${servers.url}/explore${qs}`), { max: 40 });
  }
});

test("the chips link with since=, and updated wins when both are given (#11232)", async () => {
  const res = await page("?kind=app");
  expect(res.html).toContain("since=7d");
  expect(res.html).not.toContain("updated=");
  expect(exploreLineFrom((n) => (n === "updated" ? "7d" : n === "since" ? "30d" : null))).toBe("updated:7d");
});

test("active filters show as a chip row whose removes are links, escaped (#11819)", async () => {
  expect((await page("")).html).not.toContain("data-filter-chips");
  const { html } = await page("?kind=app&sort=forks&owner=olive&q=garden");
  const row = /data-filter-chips[\s\S]*?<\/div>/.exec(html)![0];
  expect(row).toContain('href="/explore?sort=forks&amp;owner=olive&amp;q=garden"');
  expect(row).toContain("Remove kind:app");
  expect(row).toContain('role="group"');
  expect(row).toContain("Remove sort:forks");
  expect(row).toContain("Remove owner:olive");
  expect(row).toContain("Remove garden");
  const hostile = await page(`?q=${encodeURIComponent('"><img src=x onerror=1>')}`);
  expect(hostile.html).not.toContain("<img src=x");
});
