/** The repository head at rest (#8774): few tabs, the rest in "More", nothing lost, and every step in the palette. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { forkRepo } from "../src/actions/repos.ts";
import { rememberSpec } from "../src/apps/api_spec.ts";
import { createApp } from "../src/core/apps.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

// Bytes of the repository head on the snappy fixture as the owner: [before it folded its rare steps away (#8802), measured now plus room].
// Only the head is weighed: it is what this test is about, and it holds no port, clock or host, so the verdict is the head's code
// and nothing else. Weighing the whole page tripped every pull that added a few bytes to the top bar, the palette or a list (#8991).
// The head now weighs 2,700 bytes on each page, the shortcut keys beside its tabs (#8895) included; the budget leaves ~100 bytes for one more.
const HEAD_BYTES = { before: 3_808, budget: 2_800 };
const PATHS = ["", "/issues", "/pulls"];

const get = async (path: string): Promise<string> =>
  (await fetch(`${f.base}${path}`, { headers: { cookie: f.ownerCookie } })).text();

const head = (page: string): string => /<header class="repo-head">[\s\S]*?<\/header>/.exec(page)?.[0] ?? "";

test("the repository, issues and pulls pages are lighter and keep a short tab strip", async () => {
  const repo = f.repos[0]!;
  for (const path of PATHS) {
    const text = await get(`/${repo.ownerName}/${repo.name}${path}`);
    const size = new TextEncoder().encode(head(text)).length;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(HEAD_BYTES.before);
    expect(size).toBeLessThan(HEAD_BYTES.budget);
    const strip = /<nav class="tabs"[\s\S]*?<\/nav>/.exec(head(text))?.[0] ?? "";
    expect((strip.match(/<a\s/g) ?? []).length).toBeLessThanOrEqual(5);
    expect(head(text)).toContain('class="repo-nav"');
  }
});

const paletteRows = (page: string): { t: string; h: string; c: string }[] => {
  const raw = /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "{}";
  return JSON.parse(raw).items;
};

/** Every link the head draws, tabs and "More" alike. */
const headLinks = (page: string): string[] => {
  const nav = /<div class="repo-nav">[\s\S]*?<\/details><\/div>|<nav class="tabs"[\s\S]*?<\/nav>/.exec(head(page))?.[0] ?? "";
  return [...nav.matchAll(/<a\s[^>]*?href="([^"]+)"/g)].map((m) => m[1]!).sort();
};

/** The palette's rows for the steps (not its two first verbs: a new issue, telling the crew). */
const stepRows = (page: string): string[] =>
  paletteRows(page)
    .filter((r) => r.c === "This repository" && !r.h.endsWith("/issues/new") && !r.h.includes("#tell") && !/\/tell\?/.test(r.h))
    .map((r) => r.h)
    .sort();

const asViewer = async (who: "owner" | "peer" | "guest", path: string): Promise<string> =>
  (
    await fetch(`${f.base}${path}`, {
      headers: who === "guest" ? {} : { cookie: who === "owner" ? f.ownerCookie : f.peerCookie },
    })
  ).text();

test("the palette holds the head's links and no others, for the owner, a reader and a guest, on a repository with forks, an app with an API, and the terminal on", async () => {
  const plain = f.repos[6]!; // public
  const appRepo = f.repos[3]!; // public, made an app below
  const forked = await forkRepo(f.app, f.peer, plain);
  expect(forked.ok).toBe(true);
  const made = createApp(f.app.db, { repoId: appRepo.id, slug: "three", access: "public" });
  if (!made.ok) throw new Error(made.error);
  rememberSpec(made.value.id, { openapi: "3.0.0", paths: {} });
  (f.app.config as { appSsh?: string }).appSsh = "ssh -p 2222 three@localhost";

  const plainBase = `/${plain.ownerName}/${plain.name}`;
  const appBase = `/${appRepo.ownerName}/${appRepo.name}`;
  const seen = new Map<string, string[]>();
  for (const base of [plainBase, appBase])
    for (const who of ["owner", "peer", "guest"] as const)
      for (const path of ["", "/issues", "/pulls", "/map", "/events"]) {
        const page = await asViewer(who, `${base}${path}`);
        const links = headLinks(page);
        expect(links.length).toBeGreaterThan(3);
        // Nothing the head offers is missing from the palette, nothing the head hides leaks into it.
        expect([`${who} ${base}${path}`, ...stepRows(page)]).toEqual([`${who} ${base}${path}`, ...links]);
        if (path === "") seen.set(`${who} ${base}`, links);
      }

  const owner = seen.get(`owner ${plainBase}`)!;
  for (const step of ["issues", "pulls", "map", "commits", "branches", "forks", "runs", "events", "settings"])
    expect(owner).toContain(`${plainBase}/${step}`);
  expect(owner).toContain("/settings/keys#terminal");
  expect(seen.get(`owner ${appBase}`)).toContain(`${appBase}/api`);
  expect(seen.get(`owner ${appBase}`)).toContain(`${appBase}/files`);
  expect(seen.get(`guest ${appBase}`)).toContain(`${appBase}/api`);
  // A guest has no settings and no terminal; a reader no settings.
  for (const who of ["peer", "guest"] as const) expect(seen.get(`${who} ${plainBase}`)).not.toContain(`${plainBase}/settings`);
  expect(seen.get(`guest ${plainBase}`)).not.toContain("/settings/keys#terminal");
  expect(seen.get(`peer ${plainBase}`)).toContain("/settings/keys#terminal");
  expect(seen.get(`guest ${plainBase}`)).toContain(`${plainBase}/forks`);
});

test("the page you are on stays a tab even when it is a rare one", async () => {
  const repo = f.repos[0]!;
  const base = `/${repo.ownerName}/${repo.name}`;
  const strip = /<nav class="tabs"[\s\S]*?<\/nav>/.exec(head(await get(`${base}/map`)))?.[0] ?? "";
  expect(strip).toContain(`href="${base}/map"`);
  expect(strip).toContain('aria-current="page"');
});
