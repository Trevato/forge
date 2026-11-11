/** The flow keeper reports closed-without-reason and person-assigned crew pulls once, on the pull (#7556); and answers alarms in words. */
import { expect, test } from "bun:test";
import { sentence } from "../src/maintain/keeper/words.ts";
import { vantagesFromEnv } from "../src/maintain/keeper/down.ts";
import { ago, runKeeper, seed } from "./helpers/keeper-seed.ts";

const now = new Date("2026-11-11T12:00:00Z");

const comments = (s: Awaited<ReturnType<typeof seed>>, issue: string): string[] =>
  s.db.query<{ body: string }, [string]>("SELECT body FROM comment WHERE issue_id = ?1 ORDER BY rowid").all(issue).map((c) => c.body);

function close(s: Awaited<ReturnType<typeof seed>>, id: string, reason: string | null): void {
  s.db.query("UPDATE issue SET state = 'closed', close_reason = ?2, closed_at = ?3 WHERE id = ?1").run(id, reason, ago(now, 30));
}

test("a crew pull closed with no reason is said once on the pull", async () => {
  const s = await seed();
  const pull = s.pull({ number: 1, author: s.builders.ada!, createdAt: ago(now, 90) });
  close(s, pull, null);
  const first = await runKeeper(s, now);
  expect(first.actions).toContain("owner/app#1: closed, said on the pull");
  const second = await runKeeper(s, now);
  expect(second.actions.filter((a) => a.includes("closed, said"))).toEqual([]);
  const said = comments(s, pull);
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("closed with no reason given");
});

test("a crew pull assigned to a person is said once, and stays theirs", async () => {
  const s = await seed();
  const pull = s.pull({ number: 2, author: s.builders.ada!, assignee: s.person, createdAt: ago(now, 90) });
  const first = await runKeeper(s, now);
  expect(first.actions).toContain("owner/app#2: handed to pat, said on the pull");
  await runKeeper(s, now);
  expect(comments(s, pull)).toHaveLength(1);
  expect(s.db.query<{ a: string }, [string]>("SELECT assignee_id AS a FROM issue WHERE id = ?1").get(pull)!.a).toBe(s.person);
});

test("a closed pull with a reason says nothing", async () => {
  const s = await seed();
  const pull = s.pull({ number: 3, author: s.builders.ada!, createdAt: ago(now, 90) });
  close(s, pull, "dropped");
  const out = await runKeeper(s, now);
  expect(out.actions.filter((a) => a.includes("said on the pull"))).toEqual([]);
  expect(comments(s, pull)).toEqual([]);
});

test("a firing alarm yields a finding and an action line from words.ts", async () => {
  const s = await seed();
  s.db.query("INSERT INTO issue (id, repo_id, number, kind, title, author_id, created_at, updated_at) VALUES ('ready1', ?1, 9, 'issue', 'ready', ?2, ?3, ?3)").run(s.repoId, s.person, ago(now, 120));
  const out = await runKeeper(s, now);
  expect(out.findings.some((f) => f.summary.startsWith("alarm idle_crew:"))).toBe(true);
  expect(out.actions).toContain(`alarm idle_crew: ${sentence("idle_crew", { stuck: 0, reassigned: 0, lifted: 0, down: false })}`);
});

test("words answer idle_crew and unreachable, with and without an outage", () => {
  const did = { stuck: 0, reassigned: 0, lifted: 0, down: false };
  expect(sentence("idle_crew", did)).toContain("lull sampler");
  expect(sentence("unreachable", did)).toContain("no event until both fail twice");
  expect(sentence("unreachable", { ...did, down: true })).toContain("release keeper owns rollback");
  expect(sentence("other", did)).toContain("reported only");
});

test("forge_down is reached through the default runner path: env vantages, app passed", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 500 }) });
  const old = process.env.FORGE_HEALTH_VANTAGES;
  process.env.FORGE_HEALTH_VANTAGES = `home=http://127.0.0.1:${server.port}/h,far=http://127.0.0.1:${server.port}/h`;
  try {
    expect(vantagesFromEnv()).toHaveLength(2);
    const s = await seed();
    await runKeeper(s, now, { withApp: true });
    const out = await runKeeper(s, now, { withApp: true });
    expect(out.actions.some((a) => a.startsWith("forge down: health failed twice"))).toBe(true);
    expect(s.db.query<{ n: number }, []>("SELECT count(*) AS n FROM event WHERE kind = 'forge_down'").get()!.n).toBe(1);
  } finally {
    if (old === undefined) delete process.env.FORGE_HEALTH_VANTAGES;
    else process.env.FORGE_HEALTH_VANTAGES = old;
    server.stop(true);
  }
});
