/**
 * Every credential is a subscription: the forge's own token is the row
 * `platform (env)`, a run on it is counted under it, and a running
 * session's spend reaches the ledger (and the outbox) before it ends. A
 * sealed account carries a scope — the places it is granted — and one
 * granted nowhere is never offered to the crew. The breakdown sums the way
 * a hand would.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { readSpend, spanSince } from "../src/actions/spend.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { standing } from "../src/core/standing.ts";
import {
  addSubscription,
  deleteSubscription,
  EVERYONE,
  grantedAccounts,
  listCredentials,
  listGrants,
  listSubscriptions,
  pickSubscription,
  PLATFORM,
  scopesOf,
  setGrants,
} from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUsage, recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

const WORK = "sk-ant-oat01-the-owners-work-account-never-for-the-crew";

let dataDir: string;
let gateDir: string;
let app: App;
let servers: Servers;
let crew: CrewHandle;
let alice: User;
let bot: User;
let repo: Repo;

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error("did not happen in time");
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-credentials-"));
  gateDir = await mkdtemp(join(tmpdir(), "forge-credentials-gate-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  // The stand-in reports one assistant message's usage, then — when told
  // to hold — waits for the gate before it finishes, so a test can read
  // the ledger mid-run. A run on the work account fails loudly: it must
  // never be handed that token.
  const fake = join(dataDir, "fake-claude");
  writeFileSync(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "${WORK}" ]; then echo "work token used" >&2; exit 3; fi
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
echo '{"type":"assistant","session_id":"fake-1","message":{"id":"msg_1","content":[{"type":"text","text":"working"}],"usage":{"input_tokens":100,"cache_read_input_tokens":900,"output_tokens":50}}}'
if [ -f "${gateDir}/hold" ]; then
  while [ ! -f "${gateDir}/open" ]; do sleep 0.02; done
fi
echo "work by the crew" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md.","total_cost_usd":0.25,"num_turns":2,"session_id":"fake-1","terminal_reason":"completed","usage":{"input_tokens":200,"cache_read_input_tokens":1800,"output_tokens":120}}'
`,
  );
  chmodSync(fake, 0o755);
  crew = await startCrew(app, {
    forgeUrl: servers.url,
    localUrl: servers.url,
    binary: fake,
    concurrency: 1,
    budgetUsd: 2,
    runTimeoutMs: 60_000,
    // The pump picks queued runs on a tick; 5 s by default, 20 ms here, so
    // the assigned issue's run starts at once rather than on the next tick.
    tickMs: 20,
  });
  const a = await createUser(app.db, { origin: "seed", trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error("user");
  alice = a.value;
  const made = await createAgent(app, alice, { username: "bot" });
  if (!made.ok) throw new Error(String(made.error));
  bot = made.value.user;
  const created = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!created.ok) throw new Error(String(created.error));
  repo = created.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "README.md", content: "# garden\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  // The owner's work account: in the pool, granted nowhere.
  expect(addSubscription(app.db, dataDir, { name: "trevato-espo", token: WORK }).ok).toBe(true);
}, 30_000);

afterAll(async () => {
  await crew.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(gateDir, { recursive: true, force: true });
});

describe("the platform credential", () => {
  test("is a row of its own: listed first, never in the grantable pool, never removed", () => {
    // Invariant: platform (env) is listed first, is not in the grantable pool, cannot be deleted, and granting it records nothing.
    expect(listCredentials(app.db).map((c) => c.name)).toEqual([
      "platform (env)",
      "trevato-espo",
    ]);
    expect(listSubscriptions(app.db).map((c) => c.name)).toEqual(["trevato-espo"]);
    expect(deleteSubscription(app.db, PLATFORM)).toBe(false);
    // Granting it is a no-op: it is what applies when nothing is granted.
    setGrants(app.db, repo.id, EVERYONE, [PLATFORM]);
    expect(listGrants(app.db, repo.id)).toEqual([]);
    expect(standing(app.db, PLATFORM, new Date())).toBeDefined();
  });
});

describe("a subscription's scope", () => {
  test("one granted nowhere is never picked; one granted elsewhere is not picked here", () => {
    // Invariant: a subscription is picked for a repository only when granted there; elsewhere the pick falls back to env.
    const espo = listSubscriptions(app.db)[0]!;
    const scope = { repoId: repo.id, ownerId: alice.id, agentId: bot.id };
    expect(pickSubscription(app.db, dataDir, scope, new Date()).kind).toBe("env");
    expect(grantedAccounts(app.db, repo.id, alice.id)).toEqual([]);
    expect(scopesOf(app.db).has(espo.id)).toBe(false);

    setGrants(app.db, "another-repo", EVERYONE, [espo.id]);
    expect(scopesOf(app.db).get(espo.id)).toEqual(["a place that is gone"]);
    expect(pickSubscription(app.db, dataDir, scope, new Date()).kind).toBe("env");
    expect(grantedAccounts(app.db, repo.id, alice.id)).toEqual([]);
    setGrants(app.db, "another-repo", EVERYONE, []);

    // Granted here, it is picked here — and only then.
    setGrants(app.db, repo.id, EVERYONE, [espo.id]);
    const picked = pickSubscription(app.db, dataDir, scope, new Date());
    expect(picked.kind === "ready" && picked.subscription.id).toBe(espo.id);
    expect(scopesOf(app.db).get(espo.id)).toEqual(["alice/garden"]);
    setGrants(app.db, repo.id, EVERYONE, []);
  });
});

describe("a repository whose owner is not a forge admin", () => {
  test("gets none without a grant and the subscription once granted; an admin's still gets env", async () => {
    // Invariant: a non-admin owner's repository gets no credential without a grant, the subscription with one; an admin's gets env.
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error("user");
    const espo = listSubscriptions(app.db)[0]!;
    const outsider = { repoId: "bobs-repo", ownerId: b.value.id, agentId: bot.id };
    expect(pickSubscription(app.db, dataDir, outsider, new Date()).kind).toBe("none");
    setGrants(app.db, "bobs-repo", EVERYONE, [espo.id]);
    const picked = pickSubscription(app.db, dataDir, outsider, new Date());
    expect(picked.kind === "ready" && picked.subscription.id).toBe(espo.id);
    setGrants(app.db, "bobs-repo", EVERYONE, []);
    const admin = { repoId: "admins-repo", ownerId: alice.id, agentId: bot.id };
    expect(pickSubscription(app.db, dataDir, admin, new Date()).kind).toBe("env");
  });
});

describe("a crew run on the platform's token", () => {
  test("is counted under platform (env), moving while it runs", async () => {
    // Invariant: a crew run on the platform token is a running ledger line and a usage.delta mid-run, replaced by its result, read the same over the API without the work token.
    writeFileSync(join(gateDir, "hold"), "");
    const issue = openIssue(app, alice, repo, { title: "Plant tulips", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const run = await until(() =>
      listRuns(app.db, repo.id, { kind: "agent" }).find((r) => r.issueId === issue.value.id),
    );

    // Mid-run: the assistant message's 100 + 900 read and 50 written are in
    // the ledger as a running line, before any result; no cost reported yet.
    const live = await until(() => {
      const u = getUsage(app.db, run.id);
      return u?.outcome === "running" ? u : undefined;
    });
    expect(live).toMatchObject({
      subscriptionId: PLATFORM,
      tokensIn: 1_000,
      tokensOut: 50,
      costUsd: 0,
      kind: "build",
    });
    const mid = readSpend(app, new Date(), repo.id);
    const fiveHours = mid.spans.find((s) => s.span === "5h")!;
    expect(fiveHours.total).toEqual({ units: 1, tokensIn: 1_000, tokensOut: 50, costUsd: 0 });
    expect(fiveHours.byCredential.map((l) => l.name)).toEqual(["platform (env)"]);
    expect(mid.top[0]).toMatchObject({ runId: run.id, outcome: "running" });
    // …and the outbox says so, naming the run and nothing it spent.
    const delta = listEvents(app.db, { repoId: repo.id, kind: "usage.delta" })[0];
    expect(delta?.payload).toEqual({ runId: run.id });

    writeFileSync(join(gateDir, "open"), "");
    const done = await until(() => {
      const u = getUsage(app.db, run.id);
      return u !== undefined && u.outcome !== "running" ? u : undefined;
    });
    // The result replaces the line: 200 + 1800 read, 120 written, $0.25.
    expect(done).toMatchObject({
      subscriptionId: PLATFORM,
      tokensIn: 2_000,
      tokensOut: 120,
      costUsd: 0.25,
      outcome: "ok",
    });

    const after = readSpend(app, new Date());
    const week = after.spans.find((s) => s.span === "week")!;
    expect(week.byCredential).toEqual([
      { name: "platform (env)", units: 1, tokensIn: 2_000, tokensOut: 120, costUsd: 0.25 },
    ]);
    expect(week.byApp.map((l) => l.name)).toEqual(["alice/garden"]);
    expect(week.byAgent.map((l) => l.name)).toEqual(["bot"]);
    expect(week.byIssue.map((l) => l.name)).toEqual([`alice/garden#${issue.value.number}`]);
    expect(week.byKind.map((l) => l.name)).toEqual(["build"]);

    // The API and MCP read the same report: platform (env) by name, its
    // windows with it, the breakdown alongside.
    const owner = createToken(app.db, alice.id, "ro", "ro").token;
    const got = await fetch(`${servers.url}/api/v1/repos/alice/garden/usage`, {
      headers: { authorization: `Bearer ${owner}` },
    });
    const body = (await got.json()) as any;
    expect(body.bySubscription[0].subscription).toBe("platform (env)");
    expect(body.standing.map((s: any) => s.subscription)).toEqual(["platform (env)"]);
    expect(body.spend.spans.map((s: any) => s.span)).toEqual(["5h", "today", "week"]);
    expect(JSON.stringify(body)).not.toContain(WORK);
  }, 60_000);
});

describe("the breakdown", () => {
  test("sums by kind and span as a hand would, the costliest runs first", () => {
    // Invariant: spend sums by span and kind as a hand would, and the top runs are ordered costliest first.
    const now = new Date("2026-06-02T12:00:00.000Z");
    const line = (runId: string, at: string, costUsd: number, kind: "plan" | "review") =>
      recordUsage(app.db, {
        runId,
        repoId: repo.id,
        issueId: null,
        agentId: bot.id,
        subscriptionId: PLATFORM,
        kind,
        tokensIn: 10,
        tokensOut: 1,
        costUsd,
        wallMs: 1_000,
        outcome: "ok",
        at,
      });
    // Finished runs, so the crew never claims one and rewrites its line.
    let n = 0;
    const run = () => {
      const runId = `done-${++n}`;
      app.db
        .query("INSERT INTO run (id, repo_id, kind, state) VALUES (?1, ?2, 'agent', 'ok')")
        .run(runId, repo.id);
      return runId;
    };
    // 11:00 is in the last 5 h, today and the week; 02:00 today and the
    // week; three days back only the week; nine days back none.
    line(run(), "2026-06-02T11:00:00.000Z", 1, "plan");
    line(run(), "2026-06-02T02:00:00.000Z", 2, "review");
    line(run(), "2026-05-30T12:00:00.000Z", 4, "review");
    line(run(), "2026-05-24T12:00:00.000Z", 8, "plan");
    expect(spanSince("today", now)).toBe("2026-06-02T00:00:00.000Z");
    const spend = readSpend(app, now, repo.id);
    const cost = (span: string) => spend.spans.find((s) => s.span === span)!.total.costUsd;
    expect([cost("5h"), cost("today"), cost("week")]).toEqual([1, 3, 7]);
    const week = spend.spans.find((s) => s.span === "week")!;
    // review: $2 + $4 = $6 in 2 runs; plan: $1 in 1.
    expect(week.byKind.map((l) => [l.name, l.units, l.costUsd])).toEqual([
      ["review", 2, 6],
      ["plan", 1, 1],
    ]);
    expect(spend.top.map((t) => t.costUsd)).toEqual([4, 2, 1]);
  });
});

describe("the board", () => {
  test("puts the crew's credentials first and the unscoped account apart, with the spend", async () => {
    // Invariant: the board and settings pages show the crew's credentials apart from the unscoped account, with the spend views.
    const cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const page = await (await fetch(`${servers.url}/board`, { headers: { cookie } })).text();
    const crewAt = page.indexOf('data-group="crew"');
    const apartAt = page.indexOf('data-group="apart"');
    expect(crewAt).toBeGreaterThan(-1);
    expect(apartAt).toBeGreaterThan(crewAt);
    expect(page.slice(crewAt, apartAt)).toContain("platform (env)");
    expect(page.slice(crewAt, apartAt)).not.toContain("trevato-espo");
    expect(page.slice(apartAt)).toContain("trevato-espo");
    expect(page).toContain('data-live="run.queued,run.started,run.finished,usage.*"');
    expect(page).toContain('data-by="byKind"');
    expect(page).toContain("The 10 costliest runs");

    const subs = await (
      await fetch(`${servers.url}/settings/subscriptions`, { headers: { cookie } })
    ).text();
    expect(subs).toContain("platform (env)");
    expect(subs).toContain("not offered to the crew");
    expect(subs).toContain('href="/settings/spend"');

    const spend = await (await fetch(`${servers.url}/settings/spend`, { headers: { cookie } })).text();
    expect(spend).toContain('data-by="byCredential"');
    expect(spend).not.toContain("spend-table");
    expect(spend).not.toContain("spend-totals");
    expect(spend).toContain('class="table-scroll"');
    expect(spend).toContain("data-dense");
    expect(spend).toContain('data-by="top" aria-labelledby="spend-top"');
    expect(spend).toContain('id="spend-top"');
  });
});
