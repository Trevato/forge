import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { catalog } from "../src/packs/catalog.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** The content of the first tag matching, or undefined when there is none. */
function meta(html: string, key: "name" | "property", value: string): string | undefined {
  for (const m of html.matchAll(/<meta\s[^>]*>/g)) {
    const tag = m[0];
    if (!new RegExp(`${key}="${value}"`).test(tag)) continue;
    return /content="([^"]*)"/.exec(tag)?.[1];
  }
  return undefined;
}

function canonical(html: string): string | undefined {
  for (const m of html.matchAll(/<link\s[^>]*>/g))
    if (/rel="canonical"/.test(m[0])) return /href="([^"]*)"/.exec(m[0])?.[1];
  return undefined;
}

/** Every missing or empty head tag on a page, as "tag" names. */
function headProblems(html: string, origin: string): string[] {
  const out: string[] = [];
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1];
  if (!title?.trim()) out.push("<title>");
  for (const [label, key, value] of [
    ["meta name=description", "name", "description"],
    ["og:title", "property", "og:title"],
    ["og:description", "property", "og:description"],
    ["og:image", "property", "og:image"],
  ] as const)
    if (!meta(html, key, value)?.trim()) out.push(label);
  const c = canonical(html);
  if (!c?.trim()) out.push("link rel=canonical");
  else {
    let ok = false;
    try {
      ok = new URL(c).origin === origin && c.startsWith(origin + "/");
    } catch {}
    if (!ok) out.push(`link rel=canonical (${c} is not an absolute URL on ${origin})`);
  }
  return out;
}

describe("every public page names itself", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let pages: string[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-publichead-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    for (const name of ["shown", "widget"]) {
      const made = await createRepo(app, u.value, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
    }
    const shown = getRepo(app.db, "alice", "shown")!.id;
    for (const kind of ["issue", "pull"] as const) {
      const i = createIssue(app.db, { repoId: shown, authorId: u.value.id, title: `A ${kind}`, kind });
      if (!i.ok) throw new Error(String(i.error));
      if (kind === "pull")
        app.db
          .query(
            `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
             VALUES (?1, 'main', 'topic', '', '', ?2)`,
          )
          .run(i.value.id, shown);
    }
    const rec = createAppRecord(app.db, { repoId: getRepo(app.db, "alice", "widget")!.id, slug: "widget", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    const pack = catalog().packs[0];
    if (!pack) throw new Error("the catalog ships no pack to walk");
    // Walked as a stranger. Left out, on purpose: redirects to sign in (/map,
    // /new, /board, /feed...), feeds and files (/changelog.atom, /sitemap.xml),
    // and /signin-style forms, which og-tags.test.ts already covers.
    pages = [
      "/",
      "/explore",
      "/alice/shown",
      "/alice/widget",
      "/alice/shown/issues/1",
      "/alice/shown/pulls/2",
      "/packs",
      `/packs/${pack.name}`,
      "/api", // the API reference: the docs page a stranger can open
      "/agents", // the page for AI assistants
      "/changelog",
    ];
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the head checker names what is missing", () => {
    const bad = `<html><head><title> </title><link rel="canonical" href="https://elsewhere.test/x"></head></html>`;
    const found = headProblems(bad, "http://forge.test");
    expect(found).toContain("<title>");
    expect(found).toContain("og:image");
    expect(found.some((f) => f.startsWith("link rel=canonical (https://elsewhere.test/x"))).toBe(true);
  });

  test("home, explore, repo, app, issue, pull, packs, docs and changelog carry a full head", async () => {
    const failures: string[] = [];
    for (const path of pages) {
      const res = await fetch(base + path, { redirect: "manual" });
      if (res.status !== 200) {
        failures.push(`${path}: answered ${res.status}, not a page`);
        continue;
      }
      for (const p of headProblems(await res.text(), new URL(base).origin)) failures.push(`${path}: ${p}`);
    }
    expect(failures).toEqual([]);
  });
});
