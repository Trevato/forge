/**
 * Cmd-K: a repository's name finds it first, and a repository and its app are
 * one row (#7661).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { search } from "../src/actions/search.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { rankPalette, type PaletteRow } from "../src/web/palette.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-palette-repos-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const pw = "a-long-palette-passphrase";
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "trevato", email: "t@forge.local", password: pw, adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const other = await createUser(app.db, { origin: "seed", trusted: true, username: "zed", email: "z@forge.local", password: pw });
  if (!other.ok) throw new Error(other.error);
  promote(app.db, other.value);
  const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "trevato", password: pw }), redirect: "manual" });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  // The owner's real repository is the oldest; sixty newer forks and lookalikes follow.
  const first = await createRepo(app, made.value, { name: "forge", visibility: "public" });
  if (!first.ok) throw new Error(String(first.error));
  createAppRecord(app.db, { repoId: first.value.id, slug: "forge", access: "public" });
  for (let i = 0; i < 60; i++) {
    const r = await createRepo(app, other.value, { name: i % 2 === 0 ? `forge-fork-${i}` : `my-forge-${i}`, visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
  }
  const exact = await createRepo(app, other.value, { name: "forge", visibility: "public" });
  if (!exact.ok) throw new Error(String(exact.error));
}, 60_000);

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("the server's search puts exact names first, the viewer's own ahead, however many forks are newer", async () => {
  const user = getUserByName(app.db, "trevato")!;
  const out = await search(app, user, { q: "forge", kind: "repos", limit: 5 });
  const names = out.repos.map((r) => (r.source === "local" ? `${r.owner}/${r.name}` : r.fullName));
  expect(names.slice(0, 2)).toEqual(["trevato/forge", "zed/forge"]);
  expect(names[2]).toMatch(/^zed\/forge-fork-/);
});

const row = (t: string, extra: Partial<PaletteRow> = {}): PaletteRow => ({ t, h: `/${t}`, g: "Repositories", n: t.split("/")[1] ?? t, ...extra });

test("exact and prefix name matches outrank word-start and substring ones; the viewer's own lead", () => {
  const rows = [
    row("zed/my-forge-1"),
    row("zed/forge-fork-2"),
    row("zed/forge", {}),
    row("trevato/forge", { m: 1 }),
    row("trevato/forgery", { m: 1 }),
    { t: "Forges you sent", h: "/forges", g: "Go to" },
  ];
  const flat = rankPalette(rows, "forge", [], 20).flatMap((g) => g.rows.map((r) => r.t));
  expect(flat.slice(0, 4)).toEqual(["trevato/forge", "zed/forge", "trevato/forgery", "zed/forge-fork-2"]);
  // A name that only contains the word (not a prefix) trails every prefix.
  expect(flat.indexOf("zed/my-forge-1")).toBeGreaterThan(flat.indexOf("zed/forge-fork-2"));
});

test("one group, one row per repository, the app on the row and one key away", async () => {
  const html = await (await fetch(`${servers.url}/explore`, { headers: { cookie } })).text();
  const m = /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/.exec(html)!;
  const items = (JSON.parse(m[1]!) as { items: { t: string; c?: string; x?: string; o?: string; m?: number }[] }).items;
  expect(items.filter((i) => i.t === "trevato/forge")).toHaveLength(1);
  expect(items.some((i) => i.c === "Apps")).toBe(false);
  expect(items.find((i) => i.t === "trevato/forge")?.m).toBe(1);
  // An app-less repository carries no app words.
  const mine = items.find((i) => i.t === "trevato/forge")!;
  expect(mine.x).toStartWith("App · ");
  expect(mine.o).toBe("/trevato/forge/app/production/open");
  expect(items.find((i) => i.t === "zed/forge")?.x).toBeUndefined();
});

test("a private app is not known to a stranger by search, and is to its owner", async () => {
  const owner = getUserByName(app.db, "trevato")!;
  const zed = getUserByName(app.db, "zed")!;
  const made = await createRepo(app, owner, { name: "vault", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  createAppRecord(app.db, { repoId: made.value.id, slug: "vault", access: "private" });
  const flag = async (who: typeof owner | undefined) => {
    const out = await search(app, who, { q: "vault", kind: "repos", limit: 5 });
    const hit = out.repos.find((r) => r.source === "local" && r.name === "vault");
    return hit?.source === "local" ? hit.app : undefined;
  };
  expect(await flag(owner)).toBe(true);
  expect(await flag(zed)).toBe(false);
  expect(await flag(undefined)).toBe(false);
});

test("a visitor's palette holds places to go and Sign in; a signed-in one holds the full list", async () => {
  const rows = async (headers: Record<string, string>, path: string) => {
    const html = await (await fetch(`${servers.url}${path}`, { headers })).text();
    const m = /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/.exec(html)!;
    return (JSON.parse(m[1]!) as { items: { t: string; h: string; c?: string }[] }).items.filter((i) => i.c !== "Repositories");
  };
  const out = await rows({}, "/explore?q=a%26b");
  expect(out.map((i) => i.t)).toEqual(["Home", "Apps", "Explore", "Forge packs", "Front page", "Search", "Sign in"]);
  expect(out.find((i) => i.t === "Sign in")!.h).toBe("/signin");
  const inn = (await rows({ cookie }, "/explore")).map((i) => i.t);
  for (const t of ["New app", "New repository", "Migrate a repository", "New organization", "What you asked for", "Account settings", "Access tokens", "SSH keys", "Origins", "Map"]) expect(inn).toContain(t);
  expect(inn).not.toContain("Sign in");
});

test("the palette's Sign in leads where the topbar's button does, on an edge-login forge too", async () => {
  const edgeDir = await mkdtemp(join(tmpdir(), "forge-palette-edge-"));
  const edgeApp = createApp({ dataDir: edgeDir, port: 0, edgeToken: "edge-secret-for-palette" });
  const edgeServers = await serve(edgeApp);
  try {
    const items = async (headers: Record<string, string> = {}) => {
      const body = await (await fetch(`${edgeServers.url}/explore?q=a`, { headers })).text();
      const index = JSON.parse(body.match(/id="palette-index">([^<]*)</)![1]!) as { items: { t: string; h: string }[] };
      const button = body.match(/<a\s+href="([^"]*)"[^>]*>\s*Sign in\s*<\/a/)![1]!;
      return { palette: index.items.find((i) => i.t === "Sign in")!.h, button: button.replaceAll("&amp;", "&") };
    };
    const visitor = await items();
    expect(visitor.palette).toBe("/_plat/login?rd=%2Fexplore%3Fq%3Da");
    expect(visitor.button).toBe(visitor.palette);
    const stranger = await items({ "x-plat-user": "newcomer", "x-plat-edge-token": "edge-secret-for-palette" });
    expect(stranger.palette).toBe("/signup");
    expect(stranger.button).toBe("/signup");
  } finally {
    edgeServers.stop();
    edgeApp.close();
    await rm(edgeDir, { recursive: true, force: true });
  }
});
