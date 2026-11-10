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
  expect(bad.status).toBe(422);
  expect(listed(bad.html)).toEqual(listed(plain.html));
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
