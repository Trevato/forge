/**
 * Calm (#11379): the admin's home and board, with the forge deliberately odd
 * (egress in report mode, a repository on autonomy with no reviewer on its
 * crew, the week's spend at its lowest), carry no role="alert", no .banner and
 * no .notice-danger element above the main content. The odd facts are one line
 * each: egress and the week's share in Settings › Capacity, the missing
 * reviewer as the board's one `data-need` line.
 *
 * Low credit: the forge has no credit-balance state (`core/credit.ts` is
 * authorship credit; the only spend knob is `week.use`), so the lowest week
 * share stands for it. When a balance exists, add it here.
 *
 * EXCEPTIONS is the whole list of things allowed to stand on these pages by
 * name, each the real markup its source renders. Neither trips the detector
 * today; they are named so a future change that makes one loud has to say so.
 * Keep it short: a setting is never on it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp as mkTmp, rm as rmDir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { EGRESS_REPORTED } from "../src/system/egress_line.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * Named exceptions, each the markup its source renders:
 *  - a stalled flow card with its one action: `data-flow-card` (src/web/studio/flow_card.ts);
 *  - a failed deploy: the shelf row's `badge` with `data-tone` attn/danger (src/web/studio/shelf.ts).
 */
const EXCEPTIONS: Record<string, RegExp> = {
  "stalled flow card": /\bdata-flow-card=/,
  "failed deploy": /\bclass="badge"[^>]*\bdata-tone="(?:attn|danger)"/,
};

const TAG = /<[a-z][^<>]*?(?:\brole="alert"|\bclass="[^"]*\b(?:banner|notice-danger)\b[^"]*")[^<>]*>/gi;
const found = (body: string): string[] =>
  [...body.matchAll(TAG)].map((m) => m[0]).filter((t) => !Object.values(EXCEPTIONS).some((re) => re.test(t)));
/** Alarms anywhere above the first <main>, and in a <header>/<nav>, wherever it sits. */
const region = (body: string): string => {
  const at = body.search(/<main[\s>]/i);
  const above = at < 0 ? body : body.slice(0, at);
  const chrome = [...body.matchAll(/<(header|nav)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]).join("\n");
  return `${above}\n${chrome}`;
};
const alarms = (body: string): string[] => [...new Set(found(region(body)))];

let dataDir = "", cookie = "", repoId = "";
let app: App, servers: Servers;
let n = 0;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeAll(async () => {
  dataDir = await mkTmp(join(tmpdir(), "forge-calmhome-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const alice = admin.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  setCapacity(app.db, "cells.egress", "report", alice.id);
  setCapacity(app.db, "week.use", "10", alice.id);
  // No reviewer: an autonomous repository whose crew holds a builder and nobody else.
  const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  repoId = made.value.id;
  await commitToBranch(app, alice, made.value, { message: "seed", files: [{ path: "README.md", content: "# garden\n" }] });
  await createAgent(app, alice, { username: "diggerbot" });
  if (!addToCrew(app, alice, made.value, "diggerbot", "builder").ok) throw new Error("crew");
  app.db.query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1").run(repoId);
  makeAppRecord(app.db, { repoId, slug: "garden", access: "private" }); // the board lists apps
  // A stalled flow step: a pull whose check went red hours ago.
  const branch = `b${++n}`;
  const c = await commitToBranch(app, alice, made.value, { branch, base: "main", message: branch, files: [{ path: `${branch}.md`, content: "x\n" }] });
  if (!c.ok) throw new Error("branch");
  const pull = await openPull(app, alice, made.value, { title: "Stuck change", body: "", baseBranch: "main", headBranch: branch });
  if (!pull.ok) throw new Error("pull");
  app.db.query("UPDATE issue SET created_at = ?2 WHERE id = ?1").run(pull.value.id, hoursAgo(5));
  const r = createRun(app.db, { repoId, kind: "check", issueId: pull.value.id, env: `pull-${pull.value.number}`, commitOid: pull.value.headOid, reason: "pull" });
  claimRun(app.db, r.id);
  finishRun(app.db, r.id, { state: "failed", summary: "red" });
  app.db.query("UPDATE run SET created_at = ?2, finished_at = ?2 WHERE id = ?1").run(r.id, hoursAgo(4));
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rmDir(dataDir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
};

test("home and board paint no alert, banner or danger notice for the odd settings", async () => {
  for (const path of ["/", "/board"]) {
    const body = await get(path);
    expect(body.length).toBeGreaterThan(500);
    expect({ path, found: alarms(body) }).toEqual({ path, found: [] });
    expect(body).not.toContain(EGRESS_REPORTED.slice(0, 30));
  }
});

test("no reviewer is the board's one line, a link and not an alert", async () => {
  const body = await get("/board");
  expect(body.split("No reviewer: agent pulls wait for you").length - 1).toBe(1);
  expect(body).toMatch(/<a data-need href="\/asks"[^>]*>[^<]*<[^>]*>[^<]*<\/span>?/s);
});

test("a stalled flow card renders on home with its one action, and is spared", async () => {
  // The home's feed fragment, as the page loads it in studio mode.
  const res = await fetch(`${servers.url}/feed`, { headers: { cookie: `${cookie}; forge_mode=studio` } });
  const body = await res.text();
  expect(alarms(body)).toEqual([]);
  const card = body.match(/<[^>]*\bdata-flow-card="[^"]*"[^>]*>/)?.[0] ?? "";
  expect(card).not.toBe("");
  expect(body).toContain("Re-run");
  expect(EXCEPTIONS["stalled flow card"]!.test(card)).toBe(true);
  expect(found(`${card}<div role="alert">x</div>`)).toHaveLength(1);
  expect(found(`<div role="alert" ${card.slice(4, -1)}>x</div>`)).toEqual([]);
});

test("a failed deploy's badge is the markup shelf.ts renders, and is spared", () => {
  const source = readFileSync(join(import.meta.dir, "../src/web/studio/shelf.ts"), "utf8");
  expect(source).toContain('<span class="badge" data-tone="${tone}">');
  expect(source).toContain('? "attn"');
  expect(found('<span class="badge" data-tone="attn">failed</span>')).toEqual([]);
  expect(found('<span class="badge" data-tone="attn" role="alert">failed</span>')).toEqual([]);
});

test("the odd facts show in Settings as one line each", async () => {
  const body = await get("/settings/capacity");
  expect(body.split('id="egress-reported"').length - 1).toBe(1);
  expect(body).toContain(EGRESS_REPORTED);
  expect(body).toContain("Share of the week to use");
});

test("the region scan catches a banner in a page's header or nav, even after <main> opens", () => {
  expect(alarms('<header><div class="banner">x</div></header><main>y</main>')).toHaveLength(1);
  expect(alarms('<main>y</main><nav><p role="alert">x</p></nav>')).toHaveLength(1);
  expect(alarms('<div class="stack banner">x</div>')).toHaveLength(1);
  expect(alarms('<p class="notice-danger">x</p>')).toHaveLength(1);
  expect(alarms('<main><div role="alert" data-x>content</div></main>')).toEqual([]);
  expect(Object.keys(EXCEPTIONS)).toHaveLength(2);
});
