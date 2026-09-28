import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg } from "../src/actions/orgs.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import {
  addSubscription,
  deleteSubscription,
  EVERYONE,
  getSubscription,
  kindOfToken,
  listGrants,
  listSubscriptions,
  pickSubscription,
  restSubscription,
  setGrants,
  wakeSubscription,
} from "../src/core/subscriptions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { isRateLimited, resumeAt } from "../src/crew/limits.ts";
import { serve, type Servers } from "../src/http/server.ts";

const OAT = "sk-ant-oat01-personal-token-for-the-test";
const KEY = "sk-ant-api03-work-key-for-the-test";

describe("a token's kind", () => {
  test("is read from its shape, and anything else is refused", () => {
    expect(kindOfToken(OAT)).toBe("oauth");
    expect(kindOfToken(KEY)).toBe("api_key");
    expect(kindOfToken("hunter2")).toBeUndefined();
    expect(kindOfToken("sk-ant-oat01-with space")).toBeUndefined();
    expect(kindOfToken(`sk-ant-api03-${"x".repeat(600)}`)).toBeUndefined();
  });
});

describe("the pool", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-subs-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("seals a token, names it once, and never lists it", () => {
    const added = addSubscription(app.db, dataDir, {
      name: "Personal",
      token: OAT,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.kind).toBe("oauth");
    const again = addSubscription(app.db, dataDir, {
      name: "personal",
      token: KEY,
    });
    expect(again).toEqual({ ok: false, error: "name_taken" });
    expect(addSubscription(app.db, dataDir, { name: "", token: KEY })).toEqual({
      ok: false,
      error: "invalid_name",
    });
    expect(
      addSubscription(app.db, dataDir, { name: "nope", token: "hunter2" }),
    ).toEqual({ ok: false, error: "invalid_token" });
    expect(JSON.stringify(listSubscriptions(app.db))).not.toContain(OAT);
    const raw = app.db
      .query<{ token_enc: string }, []>("SELECT token_enc FROM subscription")
      .get()!;
    expect(raw.token_enc).not.toContain(OAT);
  });

  test("picks the nearest grant whole, an agent's before everyone's, and rotates", () => {
    const work = addSubscription(app.db, dataDir, { name: "work", token: KEY });
    if (!work.ok) throw new Error(work.error);
    const personal = listSubscriptions(app.db).find(
      (s) => s.name === "Personal",
    )!;
    const scope = { repoId: "repo-1", ownerId: "org-1", agentId: "bot-1" };
    const now = new Date("2026-09-28T12:00:00Z");

    // Nothing granted anywhere: the forge's own token.
    expect(pickSubscription(app.db, dataDir, scope, now)).toEqual({
      kind: "env",
    });

    // The organization's grant reaches every repository under it.
    setGrants(app.db, "org-1", EVERYONE, [personal.id]);
    let pick = pickSubscription(app.db, dataDir, scope, now);
    expect(pick.kind).toBe("ready");
    if (pick.kind !== "ready") return;
    expect(pick.subscription.name).toBe("Personal");
    expect(pick.envName).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(pick.token).toBe(OAT);

    // The repository's own grant wins over the organization's.
    setGrants(app.db, "repo-1", EVERYONE, [work.value.id]);
    pick = pickSubscription(app.db, dataDir, scope, now);
    expect(pick.kind === "ready" && pick.subscription.name).toBe("work");
    expect(pick.kind === "ready" && pick.envName).toBe("ANTHROPIC_API_KEY");

    // One agent's own grant wins over the crew's.
    setGrants(app.db, "repo-1", "bot-1", [personal.id]);
    pick = pickSubscription(app.db, dataDir, scope, now);
    expect(pick.kind === "ready" && pick.subscription.name).toBe("Personal");
    pick = pickSubscription(
      app.db,
      dataDir,
      { ...scope, agentId: "bot-2" },
      now,
    );
    expect(pick.kind === "ready" && pick.subscription.name).toBe("work");

    // Two on one grant take turns: the one used longest ago goes first.
    setGrants(app.db, "repo-1", "bot-1", []);
    setGrants(app.db, "repo-1", EVERYONE, [personal.id, work.value.id]);
    const later = (m: number) => new Date(now.getTime() + m * 60_000);
    const first = pickSubscription(app.db, dataDir, scope, later(1));
    const second = pickSubscription(app.db, dataDir, scope, later(2));
    const third = pickSubscription(app.db, dataDir, scope, later(3));
    const names = [first, second, third].map(
      (p) => p.kind === "ready" && p.subscription.name,
    );
    expect(new Set(names.slice(0, 2))).toEqual(new Set(["Personal", "work"]));
    expect(names[2]).toBe(names[0]);

    // A resting account is skipped; all resting holds the run at the soonest
    // to wake, and does not fall through to the organization's grant.
    restSubscription(app.db, personal.id, later(60).toISOString(), "weekly");
    pick = pickSubscription(app.db, dataDir, scope, later(4));
    expect(pick.kind === "ready" && pick.subscription.name).toBe("work");
    restSubscription(app.db, work.value.id, later(30).toISOString(), "session");
    pick = pickSubscription(app.db, dataDir, scope, later(5));
    expect(pick).toEqual({
      kind: "resting",
      until: later(30).toISOString(),
      said: "session",
      names: ["Personal", "work"],
    });
    // Past the soonest reset, that one is back.
    pick = pickSubscription(app.db, dataDir, scope, later(31));
    expect(pick.kind === "ready" && pick.subscription.name).toBe("work");
    wakeSubscription(app.db, personal.id);
    expect(getSubscription(app.db, personal.id)?.restingUntil).toBeNull();

    // Removing an account removes its grants; the grant falls back.
    expect(deleteSubscription(app.db, work.value.id)).toBe(true);
    expect(listGrants(app.db, "repo-1")).toEqual([
      { scopeId: "repo-1", agentId: EVERYONE, subscriptionId: personal.id },
    ]);
  });
});

describe("the provider's reset time", () => {
  const now = new Date("2026-09-23T02:10:00Z");
  test("names a date for the week's limit", () => {
    const at = resumeAt(
      "You've hit your weekly limit · resets Sep 26 at 9pm (America/Chicago)",
      now,
    );
    // 9pm Chicago on the 26th is 02:00 UTC on the 27th, plus the minute.
    expect(at.toISOString()).toBe("2026-09-27T02:01:00.000Z");
    expect(
      resumeAt("resets Sep 26, 2am (America/Chicago)", now).toISOString(),
    ).toBe("2026-09-26T07:01:00.000Z");
  });
  test("a date already past means next year's", () => {
    const at = resumeAt("resets Sep 20 at 9pm (UTC)", now);
    expect(at.toISOString()).toBe("2027-09-20T21:01:00.000Z");
  });
  test("still reads a bare clock time", () => {
    expect(resumeAt("resets 7am (UTC)", now).toISOString()).toBe(
      "2026-09-23T07:01:00.000Z",
    );
  });
  test("the weekly wording counts as the provider's refusal", () => {
    expect(
      isRateLimited({
        ok: false,
        sessionId: "",
        result: "You've hit your weekly limit · resets Sep 26 at 9pm (UTC)",
        costUsd: 0,
        turns: 0,
        reason: "error_during_execution",
      }),
    ).toBe(true);
  });
});

describe("a run on a granted account", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let countFile: string;
  let envFile: string;

  const invocations = (): number =>
    existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
  const envOf = (n: number): string => readFileSync(`${envFile}.${n}`, "utf8");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-subs-run-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    countFile = join(dataDir, "fake.count");
    envFile = join(dataDir, "fake.env");
    // The stand-in records which credential it was handed. On the personal
    // token it is out for the week, the way Claude Code says so; on the work
    // key it does the work.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
n=$(($(cat "${countFile}" 2>/dev/null || echo 0) + 1)); echo "$n" > "${countFile}"
printf 'OAUTH=%s\\nKEY=%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN" "$ANTHROPIC_API_KEY" > "${envFile}.$n"
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "${OAT}" ]; then
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You'"'"'ve hit your weekly limit · resets Sep 26 at 9pm (America/Chicago)","total_cost_usd":0,"num_turns":0,"session_id":"fake-1"}'
  exit 1
fi
echo "work by the crew" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md.","total_cost_usd":0.01,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed"}'
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
    });
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function until<T>(
    read: () => T | undefined,
    timeoutMs = 30_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(100);
    }
    throw new Error("did not happen in time");
  }

  test("rests the account the provider refused and hands the run to the next", async () => {
    const personal = addSubscription(app.db, dataDir, {
      name: "personal",
      token: OAT,
    });
    const work = addSubscription(app.db, dataDir, { name: "work", token: KEY });
    if (!personal.ok || !work.ok) throw new Error("pool");
    setGrants(app.db, repo.id, EVERYONE, [personal.value.id, work.value.id]);

    const issue = openIssue(app, alice, repo, {
      title: "Plant tulips",
      body: "",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const done = await until(() =>
      listRuns(app.db, repo.id, { kind: "agent" }).find(
        (r) => r.issueId === issue.value.id && r.state === "ok",
      ),
    );
    expect(invocations()).toBe(2);
    // Neither used before: the first by name went first, and was refused.
    expect(envOf(1)).toBe(`OAUTH=${OAT}\nKEY=\n`);
    expect(envOf(2)).toBe(`OAUTH=\nKEY=${KEY}\n`);

    const rested = getSubscription(app.db, personal.value.id)!;
    expect(rested.restingUntil).not.toBeNull();
    expect(new Date(rested.restingUntil!).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(rested.restingSaid).toContain("weekly limit");
    expect(getSubscription(app.db, work.value.id)!.restingUntil).toBeNull();

    const runs = listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) => r.issueId === issue.value.id,
    );
    // The refused run ends as the forge records every pause — cancelled,
    // with the reason on it — and a fresh run carries the task on.
    const refused = runs.find((r) => /takes over/.test(r.summary))!;
    expect(refused).toBeDefined();
    expect(refused.state).toBe("cancelled");
    expect(refused.summary).toContain("work takes over");
    const spent = app.db
      .query<
        { subscription_id: string | null },
        [string]
      >("SELECT subscription_id FROM run WHERE id = ?1")
      .get(done.id)!;
    expect(spent.subscription_id).toBe(work.value.id);
  }, 60_000);

  test("holds a run without a call while every account on the grant rests", async () => {
    const work = listSubscriptions(app.db).find((s) => s.name === "work")!;
    restSubscription(
      app.db,
      work.id,
      new Date(Date.now() + 3_600_000).toISOString(),
      "session limit",
    );
    const before = invocations();
    const issue = openIssue(app, alice, repo, {
      title: "Plant roses",
      body: "",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const held = await until(() =>
      listRuns(app.db, repo.id, { kind: "agent" }).find(
        (r) => r.issueId === issue.value.id && /resting/.test(r.summary),
      ),
    );
    expect(held.summary).toContain("personal, work resting");
    expect(invocations()).toBe(before);
    const queued = await until(() =>
      listRuns(app.db, repo.id, { kind: "agent" }).find(
        (r) =>
          r.issueId === issue.value.id &&
          r.state === "queued" &&
          r.notBefore !== null,
      ),
    );
    expect(new Date(queued.notBefore!).getTime()).toBeGreaterThan(Date.now());
  }, 30_000);
});

describe("the pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base = "";
  let cookie = "";
  let ada: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-subs-web-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const signed = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "ada",
        email: "ada@forge.example",
        password: "analytical-engine",
      }),
      redirect: "manual",
    });
    cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    ada = (await import("../src/core/users.ts")).getUserByName(app.db, "ada")!;
    const created = await createRepo(app, ada, {
      name: "hello",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const made = await createAgent(app, ada, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, ada, repo, "bot").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (path: string, body: Record<string, string> | URLSearchParams) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: body instanceof URLSearchParams ? body : new URLSearchParams(body),
      redirect: "manual",
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { cookie } }).then((r) => r.text());

  test("an admin adds an account and sees its name, never its token", async () => {
    let html = await get("/settings/subscriptions");
    expect(html).toContain("Add one");
    expect(html).toContain("The crew works on the forge");
    const added = await post("/settings/subscriptions", {
      name: "work",
      token: KEY,
    });
    expect(added.status).toBe(303);
    const refused = await post("/settings/subscriptions", {
      name: "nope",
      token: "hunter2",
    });
    expect(refused.status).toBe(303);
    expect(listSubscriptions(app.db).map((s) => s.name)).toEqual(["work"]);
    html = await get("/settings/subscriptions");
    expect(html).toContain("work");
    expect(html).toContain("API key");
    expect(html).not.toContain(KEY);
  });

  test("the crew page grants it to the repository, and a run there picks it", async () => {
    const work = listSubscriptions(app.db)[0]!;
    let html = await get(`/ada/hello/settings/crew`);
    expect(html).toContain('class="table grants"');
    expect(html).toContain(`value="*:${work.id}"`);
    const saved = await post(
      `/ada/hello/settings/crew/subscriptions`,
      new URLSearchParams([["grant", `*:${work.id}`]]),
    );
    expect(saved.status).toBe(303);
    const bot = (await import("../src/core/users.ts")).getUserByName(
      app.db,
      "bot",
    )!;
    const pick = pickSubscription(
      app.db,
      dataDir,
      { repoId: repo.id, ownerId: ada.id, agentId: bot.id },
      new Date(),
    );
    expect(pick.kind === "ready" && pick.subscription.name).toBe("work");
    html = await get("/settings/subscriptions");
    expect(html).toContain("ada/hello");
    expect(html).toContain("everyone on the crew");
    // Unticking everything takes the grant away.
    const cleared = await post(
      `/ada/hello/settings/crew/subscriptions`,
      new URLSearchParams(),
    );
    expect(cleared.status).toBe(303);
    expect(listGrants(app.db, repo.id)).toEqual([]);
  });

  test("an organization's page carries the table for every repository under it", async () => {
    const org = createOrg(app, ada, "acme");
    if (!org.ok) throw new Error(String(org.error));
    const work = listSubscriptions(app.db)[0]!;
    let html = await get("/acme");
    expect(html).toContain("Subscriptions for every repository here");
    const saved = await post(
      "/acme/-/subscriptions",
      new URLSearchParams([["grant", `*:${work.id}`]]),
    );
    expect(saved.status).toBe(303);
    expect(listGrants(app.db, org.value.id)).toEqual([
      { scopeId: org.value.id, agentId: EVERYONE, subscriptionId: work.id },
    ]);
    html = await get("/settings/subscriptions");
    expect(html).toContain("@acme");
  });

  test("nobody but an admin reaches the pool", async () => {
    const signed = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "guest",
        email: "guest@forge.example",
        password: "just-visiting-here",
      }),
      redirect: "manual",
    });
    const guest = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await fetch(`${base}/settings/subscriptions`, {
      headers: { cookie: guest },
    });
    expect(page.status).toBe(404);
    const posted = await fetch(`${base}/settings/subscriptions`, {
      method: "POST",
      headers: { cookie: guest, origin: base },
      body: new URLSearchParams({ name: "mine", token: OAT }),
      redirect: "manual",
    });
    expect(posted.status).toBe(404);
    expect(listSubscriptions(app.db)).toHaveLength(1);
  });
});
