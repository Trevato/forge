/**
 * No alarm draws a banner over the board (#11817). Every alarm a test can
 * raise is raised, and each is first asserted present, as a line of its own
 * words, on the page it belongs to; only then are those pages read for
 * anything that draws as a banner (role="alert", a danger/attn toast or card,
 * a banner or notice). An alarm is one line beside the thing it is about. The
 * failure lists every offender by page and element.
 *
 * Raised: a full disk (every page's menu, /board), an overdue failing backup
 * (home, /board), a bug past its clock and an idle crew (home), an open
 * sentinel finding (/board, the only page it shows on), egress reported
 * (/system), the crew's spend reaching the forge ceiling (home), and two flow
 * alarms besides the bug clock: main red past its ten minutes and an issue
 * parked by the repeat stop (home).
 * Not raised here: "no release" and "main is ahead", which read the git
 * history of the running commit, and the stuck, silent, lane and paid-order
 * alarms; every flow alarm draws through the same `alarmLines`, which the
 * three raised here hold to one line each.
 * Known exception, tracked in #11870: the crew-readiness danger toasts on /crew.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { addComment, createLabel, setIssueLabels } from "../src/core/issues.ts";
import { REPEAT_NOTE } from "../src/crew/repeat_note.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { provideDiskForTest } from "../src/kernel/disk_reading.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

// The forge's own repository is the one the red-main alarm reads; both globals are put back after.
const priorOwnRepo = process.env.FORGE_SENTINEL_REPO;
process.env.FORGE_SENTINEL_REPO = "alice/forge";

/**
 * An element that draws as a banner: a role="alert" shown at first paint, a
 * danger/attn toast or card, a banner or notice class. A stat tile or a dot
 * is a line beside its subject and is not one; a `hidden` alert is a slot a
 * script fills after a refusal. The whole page is read, not only what
 * precedes the first heading.
 */
/** An opening tag that draws (not script, style or an svg part) and is not `hidden`. */
const SHOWN_TAG = String.raw`<(?!script|style|svg|path)[a-z0-9]+\b(?![^>]*\bhidden\b)`;
/** `role="alert"`. */
const ALERT_ROLE = String.raw`role="alert"`;
/** A toast or card class and a danger/attn tone, in either order. */
const LOUD_TONE = String.raw`data-tone="(?:danger|attn)"`;
const BOX_CLASS = String.raw`class="[^"]*\b(?:toast|card)\b[^"]*"`;
const TONED_BOX = `${BOX_CLASS}[^>]*${LOUD_TONE}|${LOUD_TONE}[^>]*${BOX_CLASS}`;
/** A banner, notice or alert class. */
const BANNER_CLASS = String.raw`class="[^"]*\b(?:banner|notice|notice-danger|notice-warn|alert)\b[^"]*"`;
const BANNER = new RegExp(`${SHOWN_TAG}[^>]*(?:${ALERT_ROLE}|${TONED_BOX}|${BANNER_CLASS})[^>]*>`, "g");

const offenders = (path: string, html: string): string[] =>
  (html.match(BANNER) ?? []).map((tag) => `${path}: ${tag.slice(0, 120)}`);

interface World {
  readonly root: string;
  readonly app: App;
  readonly servers: Servers;
  readonly cookie: string;
}

/** A forge in an alarm state; `spent` is the crew's spend today, in dollars, against a $1 ceiling. */
async function world(spent: number): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "forge-no-alarm-banner-"));
  const app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge", crewCeilingUsd: 1 });
  const made = await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  const cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const repo = await createRepo(app, made.value, { name: "forge" });
  if (!repo.ok) throw new Error(String(repo.error));
  // A full disk.
  provideDiskForTest(() => ({ freeBytes: 1024 ** 2, totalBytes: 1000 * 1024 ** 3 }));
  // Egress reported, not enforced.
  const set = changeCapacity(app, made.value, "cells.egress", "report", "test: an alarm state");
  if (!set.ok) throw new Error(set.error);
  // An overdue off-box backup that is failing.
  mkdirSync(join(root, "snapshot"), { recursive: true });
  const long = new Date(Date.now() - 72 * 3_600_000).toISOString();
  writeFileSync(join(root, "snapshot", "state.json"), JSON.stringify({ at: long, failingSince: long, error: "the bucket refused" }));
  // A bug past its 48 h clock, in a repository that runs itself and has started no run: the bug-clock and idle-crew alarms.
  const bug = openIssue(app, made.value, repo.value, { title: "The page is blank" });
  if (!bug.ok) throw new Error(String(bug.error));
  const label = createLabel(app.db, repo.value.id, "bug", "d73a4a");
  if (!label.ok) throw new Error(label.error);
  setIssueLabels(app.db, bug.value.id, [label.value.id]);
  const old = new Date(Date.now() - 100 * 3_600_000).toISOString();
  app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(old, bug.value.id);
  app.db.query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1").run(repo.value.id);
  // An open sentinel finding.
  app.db
    .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES ('setting:x', ?1, '', 'a', 'a')")
    .run(bug.value.id);
  // An issue parked by the repeat stop, no person answering: the repeat alarm.
  const parked = openIssue(app, made.value, repo.value, { title: "The runs keep repeating" });
  if (!parked.ok) throw new Error(String(parked.error));
  const note = addComment(app.db, { issueId: parked.value.id, authorId: made.value.id, body: REPEAT_NOTE });
  if (!note.ok) throw new Error(note.error);
  // Main's last check failed half an hour ago: the red-main alarm.
  const red = new Date(Date.now() - 30 * 60_000).toISOString();
  app.db
    .query(
      `INSERT INTO run (id, repo_id, kind, env, state, summary, check_detail, commit_oid, created_at, finished_at)
       VALUES ('r-red', ?1, 'check', ?2, 'failed', '1 failed', '{"names":["home renders"]}', 'c', ?3, ?3)`,
    )
    .run(repo.value.id, repo.value.defaultBranch, red);
  // The crew's spend reaching the ceiling.
  if (spent > 0) {
    app.db
      .query("INSERT INTO run (id, repo_id, kind, cost_usd, created_at) VALUES ('r-spent', ?1, 'agent', ?2, ?3)")
      .run(repo.value.id, spent, new Date().toISOString());
  }
  return { root, app, servers: await serve(app), cookie };
}

const worlds: World[] = [];
const open = async (spent: number): Promise<World> => {
  const w = await world(spent);
  worlds.push(w);
  return w;
};
afterAll(() => {
  provideDiskForTest(undefined);
  if (priorOwnRepo === undefined) delete process.env.FORGE_SENTINEL_REPO;
  else process.env.FORGE_SENTINEL_REPO = priorOwnRepo;
  for (const w of worlds) {
    w.servers.stop();
    w.app.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

const read = async (w: World, path: string): Promise<string> => {
  const res = await fetch(`${w.servers.url}${path}`, { headers: { cookie: w.cookie }, redirect: "follow" });
  expect(res.status).toBe(200);
  return res.text();
};

/** What a person reads: the markup without tags, entities decoded, one line. */
const said = (html: string): string =>
  html
    .replace(/<(script|style|svg)\b.*?<\/\1>/gs, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");

/** Each alarm, the words it must say, and every page that must carry them. */
const ALARMS: readonly { readonly alarm: string; readonly says: string; readonly pages: readonly string[] }[] = [
  { alarm: "disk full", says: "disk has 0.0% free", pages: ["/", "/alice/forge/next", "/alice/forge", "/system"] },
  { alarm: "disk full, as the board needs it", says: "Disk is nearly full", pages: ["/board"] },
  { alarm: "backup overdue", says: "the bucket refused", pages: ["/", "/board"] },
  { alarm: "bug past its clock", says: "Bug past its clock: alice/forge#1", pages: ["/"] },
  { alarm: "main red", says: "Main has been red for", pages: ["/"] },
  { alarm: "repeating issue", says: "alice/forge#2 ran more than three times in ten minutes", pages: ["/"] },
  { alarm: "sentinel finding", says: "The sentinel has 1 open finding", pages: ["/board"] },
  { alarm: "egress reported", says: "Egress is reported, not enforced", pages: ["/system"] },
];
const PAGES = ["/", "/alice/forge/next", "/alice/forge", "/board", "/system"];

test("each alarm is raised, said on its page, and no page draws a banner for any of them", async () => {
  const w = await open(0);
  const html = new Map<string, string>();
  for (const path of PAGES) {
    const page = await read(w, path);
    expect(page).toContain("<main");
    html.set(path, page);
  }
  for (const { alarm, says, pages } of ALARMS) {
    for (const path of pages) expect(said(html.get(path)!), `${alarm} on ${path}`).toContain(says);
  }
  const found = PAGES.flatMap((path) => offenders(path, html.get(path)!));
  expect(found).toEqual([]);
});

test("the idle-crew alarm is said on home while the spend is under the ceiling", async () => {
  const w = await open(0);
  expect(said(await read(w, "/"))).toContain("ready and no crew run has started");
});

test("the spend reaching the ceiling is said on home, the crew is paused on purpose, and no banner draws", async () => {
  const w = await open(2.5);
  const home = await read(w, "/");
  expect(said(home)).toContain("Crew spend today $2.50 of $1.00 ceiling hit");
  expect(said(home)).not.toContain("no crew run has started");
  expect(offenders("/", home)).toEqual([]);
});

test("the detector names a banner and passes the lines the forge really draws", () => {
  const banner = '<div class="toast" data-tone="attn" role="status">Disk is low</div>';
  expect(offenders("/", `<main id="main">${banner}<h1>Home</h1></main>`)).toHaveLength(1);
  expect(offenders("/", '<p role="alert">Disk is low</p>')).toHaveLength(1);
  expect(offenders("/", '<div class="stack banner">x</div>')).toHaveLength(1);
  // Markup copied from the rendered pages: the home alarm line, the board's need, the menu item that carries the disk.
  expect(offenders("/", '<p class="small"><a href="/flow">No off-box backup has landed. The snapshot failed: the bucket refused</a></p>')).toEqual([]);
  expect(offenders("/board", '<li><a data-need id="sentinel" href="/trevato/forge/issues"><span class="dot" data-tone="attn"></span> The sentinel has 1 open finding</a></li>')).toEqual([]);
  expect(offenders("/", '<span class="menu-item" aria-disabled="true" title="this host&#39;s disk has 0.0% free">New forge</span>')).toEqual([]);
  expect(offenders("/", '<p class="error" role="alert" hidden></p>')).toEqual([]);
  expect(offenders("/", '<a class="stat" data-tone="attn" href="/x">Backup overdue</a>')).toEqual([]);
  // The known exception (#11870): the crew-readiness toast is a banner, and the detector sees it.
  expect(offenders("/crew", '<div class="toast" data-tone="danger" role="alert"><div class="toast-body">No crew runner is up</div></div>')).toHaveLength(1);
});
