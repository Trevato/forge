/**
 * /system and /map answer at first sight (#11111): the standing explanatory notes became a word or
 * a glyph beside the figure they explain, or moved behind one `?` (a closed `<details>`), the cut
 * /agents got in #11078. A note is any element, whatever its tag, that carries a note class token
 * (muted, small, note, hint, why) and says more than four words; the count is of what the page
 * renders outside its disclosures, and each page's ceiling is half of what main rendered.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const NOTE = ["muted", "small", "note", "hint", "why"];

/** The note elements of a page outside its closed disclosures: any tag, a note class, over four words. */
function notesOf(page: string): string[] {
  const main = page.slice(page.indexOf(`<div class="page-head`)).replace(/<details\b[\s\S]*?<\/details>/g, "");
  const out: string[] = [];
  for (const m of main.matchAll(/(?=<([a-z0-9]+)\b[^>]*\bclass="([^"]*)"[^>]*>([\s\S]*?)<\/\1>)/g)) {
    const classes = m[2]!.split(/\s+/);
    // Data is not a note: a monospace reading, or the label of the buttons it sits beside.
    if (!classes.some((c) => NOTE.includes(c)) || classes.includes("mono") || m[3]!.includes("<button")) continue;
    const words = m[3]!.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean);
    if (words.length > 4) out.push(words.join(" "));
  }
  return out;
}

/** What main rendered for the same fixtures, counted before the cut. */
const MAIN_SYSTEM = 12;
const MAIN_MAP = 2;

/** Every explanation the cut moved is still on the page, closed behind one `?` each. */
const HELP = { "/system": "sys-more", "/alice/plan/map": "map-more" } as const;

let dir: string;
let app: App;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-first-sight-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  token = createToken(app.db, u.value.id, "t", "admin").token;
  const made = await createRepo(app, u.value, { name: "plan", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  if (!openIssue(app, u.value, made.value, { title: "Alpha work" }).ok) throw new Error("issue");
}, 30_000);
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> =>
  (await fetch(servers.url + path, { headers: { authorization: `Bearer ${token}` } })).text();

describe("first sight", () => {
  test("each page keeps its how-to behind one `?` disclosure, and the action links beside it", async () => {
    for (const [path, id] of Object.entries(HELP)) {
      const page = await get(path);
      expect(page).toContain(`<details id="${id}" class="disclosure">`);
      expect(page).toMatch(/<summary>\? How to read this<\/summary>/);
    }
    const system = await get("/system");
    expect(system).toMatch(/id="sys-more"[\s\S]*id="cell-caps" data-by="(kernel|watch)"/);
    // A control keeps its word beside it: pause is in the head, not behind the `?`.
    expect(system.slice(system.indexOf('class="page-head"'), system.indexOf('id="sys-more"'))).toContain('href="/system?pause"');
    expect(system).toMatch(/id="cap-words"[^>]*>\s*<span class="pill"[^>]*>cell memory: (kernel-capped|watched)/);
    // What each cache holds is text inside the `?`, not a hover-only title.
    expect(system.slice(system.indexOf('id="sys-more"'))).toMatch(/<li><strong>kept pages<\/strong>: a stranger&#39;s/);
    expect(system).not.toContain('title="a stranger');
    const map = await get("/alice/plan/map");
    expect(map.slice(map.indexOf('id="map-more"'), map.indexOf('id="map-live"'))).not.toContain("/milestones");
    expect(map.slice(map.indexOf('class="page-head'), map.indexOf('id="map-more"'))).toContain("/alice/plan/next");
  });
  test("/system renders at most half the notes main did", async () => {
    const notes = notesOf(await get("/system"));
    expect(notes.length).toBeLessThanOrEqual(Math.floor(MAIN_SYSTEM / 2));
  });
  test("/map renders at most half the notes main did", async () => {
    const notes = notesOf(await get("/alice/plan/map"));
    expect(notes.length).toBeLessThanOrEqual(Math.floor(MAIN_MAP / 2));
  });
});
