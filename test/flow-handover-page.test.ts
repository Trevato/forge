/** /flow names hand-overs, pulls one review round away, and the pulls to rebase first (#11456). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { HANDOVER_NOTE } from "../src/crew/guard.ts";
import type { RepoDrift } from "../src/flow/alarm_drift.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { readDrifts } from "../src/flow/alarm_drift.ts";
import { readHandoverLists, readHandovers } from "../src/flow/handover_read.ts";
import { handoverLines } from "../src/tui/screens/flow.ts";
import { handoverSection } from "../src/web/pages/flow-handover.ts";

const section = (drifts: readonly RepoDrift[], now: number): string | null => {
  const out = handoverSection(readHandoverLists(app.db, drifts, now));
  return out === null ? null : String(out);
};
/** The `<li>` rows under the h3 whose title starts with `title`; 0 when the list is absent. */
const rows = (out: string, title: string): number => {
  const at = out.indexOf(`<h3>${title}`);
  if (at < 0) return 0;
  const list = out.slice(at, out.indexOf("</ul>", at));
  return list.match(/<li>/g)?.length ?? 0;
};

const NOW = Date.parse("2026-11-11T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

let app: App;
let servers: Servers;
let alice: string;
let repoId: string;
let n = 0;

function pull(): { n: number; id: string } {
  const issue = id();
  n++;
  app.db.query("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'open', ?5)").run(issue, repoId, n, alice, ago(1));
  app.db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, '', '', ?3)").run(issue, `b/${n}`, repoId);
  return { n, id: issue };
}
const review = (issue: string, state: string, h: number) =>
  app.db.query("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, ?4, 'h', ?5)").run(id(), issue, alice, state, ago(h));
const drift = (number: number, landings: number): RepoDrift => ({ repo: "alice/r", number, landings, since: NOW - landings * 3_600_000 });

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "flow-handover-")), port: 0 });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value.id;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: alice, name: "r", visibility: "public", description: "r" });
  if (!r.ok) throw new Error(r.error);
  repoId = r.value.id;
  servers = await serve(app);
}, 30_000);
afterAll(() => {
  servers?.stop?.();
  app.close?.();
});

test("empty: no section", () => {
  expect(section([], NOW)).toBeNull();
});

test("the three lists, on the page and on /flow", async () => {
  const handed = pull();
  app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(alice, handed.id);
  app.db.query("INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(id(), handed.id, alice, `${HANDOVER_NOTE} three rounds`, ago(2));
  const old = pull();
  app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(alice, old.id);
  app.db.query("INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(id(), old.id, alice, `${HANDOVER_NOTE} long ago`, ago(30));
  const near = pull();
  review(near.id, "changes_requested", 5);
  review(near.id, "changes_requested", 4);
  const behind = pull();
  const held = pull();
  app.db.query("INSERT INTO pull_hold (id, issue_id, held_by, why) VALUES (?1, ?2, ?3, ?4)").run(id(), held.id, alice, "wait");

  const out = section([drift(behind.n, 3), drift(held.n, 9)], NOW) ?? "";
  expect(rows(out, "Handed to a person")).toBe(1);
  expect(out).toContain(`href="/alice/r/pulls/${handed.n}"`);
  expect(out).not.toContain(`href="/alice/r/pulls/${old.n}"`);
  expect(rows(out, "One review round")).toBe(1);
  expect(out).toContain(`href="/alice/r/pulls/${near.n}"`);
  expect(rows(out, "Bring up to date")).toBe(1);
  expect(out).toContain(`action="/alice/r/pulls/${behind.n}/update"`);
  expect(out).not.toContain(`/pulls/${held.n}/update`);

  // Wired into /flow: the page shows the lists for the owner.
  const page = await (await fetch(`${servers.url}/flow`, { headers: { cookie: await signin() } })).text();
  expect(page).toContain('id="handover"');
  expect(page).toContain(`href="/alice/r/pulls/${handed.n}"`);
  expect(rows(page, "One review round")).toBe(1);
});

async function signin(): Promise<string> {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

test("rebase list: five at most, approved first; three rounds is not near; only lists with rows", () => {
  const behind = Array.from({ length: 7 }, () => pull());
  const approved = behind[6]!;
  review(approved.id, "approved", 3);
  const three = pull();
  for (const h of [9, 8, 7]) review(three.id, "changes_requested", h);
  const drifts = behind.map((p, i) => drift(p.n, 10 - i));
  const out = section(drifts, NOW) ?? "";
  expect(rows(out, "Bring up to date")).toBe(5);
  expect(out.match(/\/update"/g)?.length).toBe(5);
  // The approved pull is behind least yet comes first of the five.
  expect(out.indexOf(`/pulls/${approved.n}/update`)).toBeGreaterThan(-1);
  expect(out.indexOf(`/pulls/${approved.n}/update`)).toBeLessThan(out.indexOf(`/pulls/${behind[0]!.n}/update`));
  expect(out).not.toContain(`/pulls/${behind[5]!.n}/update`);
  expect(out).not.toContain(`/pulls/${three.n}"`);
  expect(out).not.toContain("None.");
});

test("a closed pull is not a hand-over", () => {
  const p = pull();
  app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(alice, p.id);
  app.db.query("INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(id(), p.id, alice, `${HANDOVER_NOTE} x`, ago(1));
  expect(readHandovers(app.db, NOW).some((h) => h.number === p.n)).toBe(true);
  app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(p.id);
  expect(readHandovers(app.db, NOW).some((h) => h.number === p.n)).toBe(false);
});

test("/flow shows a rebase form; an unsafe repository name is skipped and the page still renders", async () => {
  const behind = pull();
  const bad = id();
  app.db.query("INSERT INTO repo (id, owner_id, name, visibility, description, created_at) VALUES (?1, ?2, 'bad name', 'public', '', ?3)").run(bad, alice, ago(1));
  const badIssue = id();
  app.db.query("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, 1, 'pull', 'P', '', ?3, 'open', ?4)").run(badIssue, bad, alice, ago(1));
  app.db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', 'x', '', '', ?2)").run(badIssue, bad);
  const drifts = await readDrifts(app, { read: async () => ({ landings: 4, since: NOW - 3_600_000 }) });
  expect(drifts.some((d) => d.repo.includes("bad name"))).toBe(false);
  expect(drifts.some((d) => d.number === behind.n)).toBe(true);
  const res = await fetch(`${servers.url}/flow`, { headers: { cookie: await signin() } });
  expect(res.status).toBe(200);
  app.db.query("DELETE FROM pull WHERE issue_id = ?1").run(badIssue);
  app.db.query("DELETE FROM issue WHERE id = ?1").run(badIssue);
  app.db.query("DELETE FROM repo WHERE id = ?1").run(bad);
});

test("the update form's back field is only taken as a local path", async () => {
  const p = pull();
  const cookie = await signin();
  for (const [back, expected] of [["https://evil.example/x", `/alice/r/pulls/${p.n}`], ["//evil.example", `/alice/r/pulls/${p.n}`], ["/flow", "/flow"]] as const) {
    const res = await fetch(`${servers.url}/alice/r/pulls/${p.n}/update`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ back }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(expected);
  }
});

test("the terminal lists the same rows, numbered", () => {
  const lines = handoverLines({ handed: [{ repo: "a/r", number: 1 }], near: [], rebase: [{ repo: "a/r", number: 2 }] }, 56);
  expect(lines.join("\n")).toContain("Handed to a person");
  expect(lines.join("\n")).not.toContain("One review round");
  expect(lines.join("\n")).toContain("1 a/r #2");
  expect(handoverLines({ handed: [], near: [], rebase: [] }, 56)).toEqual([]);
});
