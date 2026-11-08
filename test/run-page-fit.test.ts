/**
 * A crew run's page fits a 390 px phone (#9347): seeded long content — a
 * 300-character unbroken word in the summary and the log, a long issue title,
 * a long file path, many log lines — ships no fixed width over 390 px; the
 * head and the live region break long words anywhere, and the log box wraps
 * and scrolls inside its own bounds, never the page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { MAX_TITLE } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { RUN_PAGE_CSS } from "../src/web/pages/runs.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { seedAdmin } from "./helpers/admin.ts";

const WORD = "W".repeat(300);
const TITLE = "T".repeat(MAX_TITLE - 10);
const PATH = `src/${"deeply-nested-directory/".repeat(12)}file-with-a-long-name.ts`;
let dir: string;
let app: App;
let servers: Servers;
let page: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-run-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  const u = made.value;
  const repo = await createRepo(app, u, { name: "fit", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const issue = openIssue(app, u, repo.value, { title: TITLE, body: "b" });
  if (!issue.ok) throw new Error(String(issue.error));
  const run = createRun(app.db, { repoId: repo.value.id, kind: "agent", issueId: issue.value.id, actorId: u.id, reason: "assigned" });
  claimRun(app.db, run.id);
  appendRunLog(dir, run.id, WORD);
  appendRunLog(dir, run.id, `→ Read ${PATH}`);
  appendRunLog(dir, run.id, `→ Bash ${WORD}`);
  for (let i = 0; i < 60; i++) appendRunLog(dir, run.id, `line ${i}: edited ${PATH}`);
  finishRun(app.db, run.id, { state: "ok", summary: `Changed ${WORD}`, costUsd: 1.25 });
  const cookie = `forge_session=${createSession(app.db, u.id).token}`;
  const res = await fetch(`${servers.url}/alice/fit/runs/${run.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  page = await res.text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const styles = (): string => (page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");

describe("a crew run's page at 390 px", () => {
  test("the long content is on the page, in many log rows", () => {
    expect(page).toContain(WORD);
    expect(page).toContain(TITLE);
    expect(page).toContain(PATH);
    expect(page.match(/data-line="say"/g)?.length ?? 0).toBeGreaterThanOrEqual(60);
  });

  test("no inline width and no shipped rule fixes a width over 390 px", () => {
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    const over: string[] = [];
    for (const css of [base, components, content, styles()]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the head and the live region break long words anywhere", () => {
    expect(page).toContain('id="run-head"');
    expect(page).toContain('id="run-live"');
    expect(styles()).toContain(RUN_PAGE_CSS);
    expect(RUN_PAGE_CSS).toMatch(/#run-head\b[^{]*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
    expect(RUN_PAGE_CSS).toMatch(/#run-live\b[^{]*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
  });

  test("the log box wraps its lines and scrolls inside itself", () => {
    expect(page).toMatch(/class="run-log"[^>]*id="run-log"/);
    const rule = content.match(/\.run-log \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/overflow:\s*auto/);
    // Space, not a frame (#9727).
    expect(rule).toMatch(/border:\s*0/);
    expect(rule).toMatch(/background:\s*none/);
    expect(content).toMatch(/\.run-log \.row-title \{[^}]*white-space:\s*pre-wrap/);
  });

  test("with the frame gone, a log row fixes no width beyond its 72px speaker column (#9727)", () => {
    const rule = (sel: string) =>
      [...content.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1]!.trim() === sel)?.[2] ?? "";
    // The log has no side padding and no border: its rows get the page's whole width.
    expect(rule(".run-log")).toMatch(/padding:\s*8px 0;/);
    // The speaker column is the only fixed width: 72px, well under 390.
    expect(rule(".run-log .row-lead")).toMatch(/flex:\s*0 0 72px/);
    // The words take what is left and may shrink below their content, wrapping in place.
    expect(components).toMatch(/\.row-main \{[^}]*flex:\s*1;[^}]*min-width:\s*0/);
    expect(rule(".run-log .row-title")).toMatch(/white-space:\s*pre-wrap/);
    expect(rule(".run-log .row-title")).not.toMatch(/nowrap|min-width/);
  });
});
