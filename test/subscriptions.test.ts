import { getHeadroom, setHeadroom } from "../src/core/standing.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
  credentialEnvOf,
  deleteSubscription,
  EVERYONE,
  getSubscription,
  hostOfApiBase,
  kindOfToken,
  listGrants,
  listSubscriptions,
  normalizeToken,
  parseApiBase,
  pickSubscription,
  restSubscription,
  setGrants,
  wakeSubscription,
} from "../src/core/subscriptions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { isRateLimited, resumeAt } from "../src/crew/limits.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { stylesheetAsset } from "../src/web/asset.ts";
import { adminCookie } from "./helpers/admin.ts";

const OAT = "sk-ant-oat01-personal-token-for-the-test";
const KEY = "sk-ant-api03-work-key-for-the-test";

const OR_KEY = "sk-or-v1-openrouter-key-for-the-test-aaaaaaaa";
const GATEWAY = "https://openrouter.ai/api";

describe("a token's kind", () => {
  test("a setup-token is a plan; any other secret is an API key; whitespace and a Bearer prefix from the paste are dropped; nothing and absurd lengths are refused", () => {
    expect(kindOfToken(OAT)).toBe("oauth");
    expect(kindOfToken(KEY)).toBe("api_key");
    expect(kindOfToken(OR_KEY)).toBe("api_key");
    expect(kindOfToken("sk-ant-usr01-credits-with-a-subscription")).toBe("api_key");
    expect(kindOfToken("hunter2")).toBe("api_key");
    expect(kindOfToken("")).toBeUndefined();
    expect(kindOfToken(normalizeToken("sk-ant-oat01-wrapped\nacross lines"))).toBe("oauth");
    expect(normalizeToken(`${KEY}\n`)).toBe(KEY);
    expect(normalizeToken("  Bearer my-own-gateway.key/v2:abc")).toBe("my-own-gateway.key/v2:abc");
    expect(normalizeToken(" sk-ant-api03-a\u00a0b\u200bc \n")).toBe("sk-ant-api03-abc");
    expect(kindOfToken(normalizeToken(" \n\u200b "))).toBeUndefined();
    // Only a cleaned token is judged: whitespace left in is refused, never quietly kept.
    expect(kindOfToken(`${KEY}\n`)).toBeUndefined();
    expect(kindOfToken(`sk-ant-api03-${"x".repeat(5000)}`)).toBeUndefined();
  });

  test("parses an Anthropic-compatible base URL, stripping /v1", () => {
    expect(parseApiBase("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api",
    );
    expect(parseApiBase("https://openrouter.ai/api/")).toBe(
      "https://openrouter.ai/api",
    );
    expect(parseApiBase("http://openrouter.ai/api")).toBeUndefined();
    expect(parseApiBase("https://user:pass@openrouter.ai/api")).toBeUndefined();
    expect(hostOfApiBase(GATEWAY)).toBe("openrouter.ai");
  });
});

describe("the pool", () => {
  let dataDir: string;
  let app: App;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-subs-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterEach(async () => {
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
      addSubscription(app.db, dataDir, { name: "nope", token: " \n " }),
    ).toEqual({ ok: false, error: "invalid_token" });
    expect(JSON.stringify(listSubscriptions(app.db))).not.toContain(OAT);
    const raw = app.db
      .query<{ token_enc: string }, []>("SELECT token_enc FROM subscription")
      .get()!;
    expect(raw.token_enc).not.toContain(OAT);
  });

  test("seals an OpenRouter key with its gateway and injects Claude Code env", () => {
    const added = addSubscription(app.db, dataDir, {
      name: "openrouter",
      token: OR_KEY,
      apiBase: "https://openrouter.ai/api/v1",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.kind).toBe("api_key");
    expect(added.value.apiBase).toBe("https://openrouter.ai/api");
    setGrants(app.db, "repo-or", EVERYONE, [added.value.id]);
    const pick = pickSubscription(
      app.db,
      dataDir,
      { repoId: "repo-or", ownerId: "org-or", agentId: "bot-or" },
      new Date("2026-10-07T12:00:00Z"),
    );
    expect(pick.kind).toBe("ready");
    if (pick.kind !== "ready") return;
    expect(pick.apiBase).toBe("https://openrouter.ai/api");
    expect(credentialEnvOf(pick)).toEqual({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: OR_KEY,
      ANTHROPIC_API_KEY: "",
    });
    expect(
      addSubscription(app.db, dataDir, {
        name: "oauth-gateway",
        token: OAT,
        apiBase: GATEWAY,
      }),
    ).toEqual({ ok: false, error: "invalid_api_base" });
    expect(
      addSubscription(app.db, dataDir, {
        name: "bad-base",
        token: OR_KEY,
        apiBase: "not a url",
      }),
    ).toEqual({ ok: false, error: "invalid_api_base" });
  });

  test("picks the nearest grant whole, an agent's before everyone's, and rotates", () => {
    const work = addSubscription(app.db, dataDir, { name: "work", token: KEY });
    if (!work.ok) throw new Error(work.error);
    const added = addSubscription(app.db, dataDir, {
      name: "Personal",
      token: OAT,
    });
    if (!added.ok) throw new Error(added.error);
    const personal = added.value;
    const scope = { repoId: "repo-1", ownerId: "org-1", agentId: "bot-1" };
    const now = new Date("2026-09-28T12:00:00Z");

    // Nothing granted anywhere, and "org-1" is no forge admin: none.
    expect(pickSubscription(app.db, dataDir, scope, now)).toEqual({
      kind: "none",
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
        tokensIn: 0,
        tokensOut: 0,
        contextTokens: 0,
        contextWindow: 0,
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
  }, 30_000);

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

  // Both accounts on the repository's grant, awake, whatever ran before.
  function pool() {
    const named = (name: string, token: string) => {
      const found = listSubscriptions(app.db).find((s) => s.name === name);
      if (found) return found;
      const added = addSubscription(app.db, dataDir, { name, token });
      if (!added.ok) throw new Error(added.error);
      return added.value;
    };
    const personal = named("personal", OAT);
    const work = named("work", KEY);
    wakeSubscription(app.db, personal.id);
    wakeSubscription(app.db, work.id);
    setGrants(app.db, repo.id, EVERYONE, [personal.id, work.id]);
    return { personal, work };
  }

  test("rests the account the provider refused and hands the run to the next", async () => {
    const { personal, work } = pool();
    const used = invocations();

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
    expect(invocations()).toBe(used + 2);
    // Neither used before: the first by name went first, and was refused.
    expect(envOf(used + 1)).toBe(`OAUTH=${OAT}\nKEY=\n`);
    expect(envOf(used + 2)).toBe(`OAUTH=\nKEY=${KEY}\n`);

    const rested = getSubscription(app.db, personal.id)!;
    expect(rested.restingUntil).not.toBeNull();
    expect(new Date(rested.restingUntil!).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(rested.restingSaid).toContain("weekly limit");
    expect(getSubscription(app.db, work.id)!.restingUntil).toBeNull();

    const runs = listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) => r.issueId === issue.value.id,
    );
    // The refused run ends as the forge records every pause — cancelled,
    // with the reason on it — and a fresh run carries the task on.
    const refused = runs.find((r) => /takes over/.test(r.summary))!;
    expect(refused).toBeDefined();
    expect(refused.state).toBe("cancelled");
    expect(refused.summary).toContain("work takes over");
    // The refused run named the real reason, not a generic pause.
    expect(refused.summary).toMatch(/personal's (weekly|5-hour) window is full until \d\d:\d\d UTC/);
    // Stickiness: the run never changed account mid-flight; the successor did.
    const first = app.db
      .query<{ subscription_id: string | null }, [string]>(
        "SELECT subscription_id FROM run WHERE id = ?1",
      )
      .get(refused.id)!;
    expect(first.subscription_id).toBe(personal.id);
    expect(done.id).not.toBe(refused.id);
    const spent = app.db
      .query<
        { subscription_id: string | null },
        [string]
      >("SELECT subscription_id FROM run WHERE id = ?1")
      .get(done.id)!;
    expect(spent.subscription_id).toBe(work.id);
  }, 60_000);

  test("holds a run without a call while every account on the grant rests", async () => {
    const { personal, work } = pool();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    restSubscription(app.db, personal.id, later, "weekly limit");
    restSubscription(app.db, work.id, later, "session limit");
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
    cookie = await adminCookie(app, {
      username: "ada",
      email: "ada@forge.example",
      password: "analytical-engine",
    });
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
  }, 30_000);

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

  // The one account the pages work on, added once whatever ran before.
  const account = () => {
    const found = listSubscriptions(app.db).find((s) => s.name === "work");
    if (found) return found;
    const added = addSubscription(app.db, dataDir, { name: "work", token: KEY });
    if (!added.ok) throw new Error(added.error);
    return added.value;
  };

  test("an admin adds an account and sees its name, never its token", async () => {
    // The empty pool is what this test starts from, whatever ran before.
    for (const s of listSubscriptions(app.db)) deleteSubscription(app.db, s.id);
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
      token: "\u200b",
    });
    expect(refused.status).toBe(303);
    expect(listSubscriptions(app.db).map((s) => s.name)).toEqual(["work"]);
    html = await get("/settings/subscriptions");
    expect(html).toContain("work");
    expect(html).toContain("API key");
    expect(html).not.toContain(KEY);
  });

  test("the crew page grants it to the repository, and a run there picks it", async () => {
    const work = account();
    let html = await get(`/ada/hello/settings/crew`);
    expect(html).toContain('<table class="table">');
    expect(html).not.toContain('class="table grants"');
    expect(html).not.toContain("grants-foot");
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
    const work = account();
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

  test("an admin keeps a share of each window for people, and sees each window", async () => {
    const work = account();
    setHeadroom(app.db, work.id, 0);
    let html = await get("/settings/subscriptions");
    expect(html).toContain(`action="/settings/subscriptions/${work.id}/headroom"`);
    expect(html).toContain("5-hour: ~$0.00 used · opens on next use");
    const kept = await post(`/settings/subscriptions/${work.id}/headroom`, {
      headroom: "25",
    });
    expect(kept.status).toBe(303);
    expect(getHeadroom(app.db, work.id)).toBe(25);
    for (const bad of ["91", "-5", "ten", ""]) {
      const refused = await post(`/settings/subscriptions/${work.id}/headroom`, {
        headroom: bad,
      });
      expect(refused.status).toBe(303);
    }
    expect(getHeadroom(app.db, work.id)).toBe(25);
    html = await get("/settings/subscriptions");
    expect(html).toContain('value="25"');
    // Without the page's own origin, nothing changes.
    const forged = await fetch(`${base}/settings/subscriptions/${work.id}/headroom`, {
      method: "POST",
      headers: { cookie, origin: "https://elsewhere.example" },
      body: new URLSearchParams({ headroom: "0" }),
      redirect: "manual",
    });
    expect(forged.status).toBe(403);
    expect(getHeadroom(app.db, work.id)).toBe(25);
  });

  test("the headroom form is §5's row fields, with no class of its own", async () => {
    const work = account();
    const html = await get("/settings/subscriptions");
    expect(html).not.toContain('class="headroom');
    expect(html).toContain(`action="/settings/subscriptions/${work.id}/headroom"`);
    expect(html).toMatch(/<form\s+class="row-fields"[^>]*headroom"/);
    expect(html).toMatch(/<input[^>]*name="headroom"/);
    const css = await (await fetch(`${base}${stylesheetAsset().path}`)).text();
    expect(css).toContain(".row-fields");
    expect(css).not.toContain(".headroom");
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
    expect(page.status).toBe(403);
    const posted = await fetch(`${base}/settings/subscriptions`, {
      method: "POST",
      headers: { cookie: guest, origin: base },
      body: new URLSearchParams({ name: "mine", token: OAT }),
      redirect: "manual",
    });
    expect(posted.status).toBe(403);
    const work = account();
    expect(listSubscriptions(app.db)).toHaveLength(1);
    setHeadroom(app.db, work.id, 25);
    const headroom = await fetch(`${base}/settings/subscriptions/${work.id}/headroom`, {
      method: "POST",
      headers: { cookie: guest, origin: base },
      body: new URLSearchParams({ headroom: "0" }),
      redirect: "manual",
    });
    expect(headroom.status).toBe(403);
    expect(getHeadroom(app.db, work.id)).toBe(25);
  });
});
