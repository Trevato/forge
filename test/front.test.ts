/**
 * The front page (#686): the forge featured with its crew at work, the best
 * of what is public ranked by real signals with at most two per owner near
 * the top, and a site admin's pins and hides — on the page, the API and the
 * MCP alike. Refusals first: a stranger and a plain member never set it, and
 * nothing private is ever shown, pinned or not.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgetFrontScores } from "../src/actions/front.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import {
  AppsRuntime,
  type EnvState,
  type EnvStatus,
} from "../src/apps/runtime.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import {
  frontScore,
  frontSignals,
  NEAR_TOP,
  rankFront,
  type FrontSignals,
} from "../src/core/front.ts";
import { recordLook } from "../src/core/looks.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const NOW = Date.parse("2026-10-05T12:00:00Z");
const none: FrontSignals = {
  awakeHours: 0,
  ships: 0,
  forks: 0,
  shippedAt: null,
};

describe("ranking", () => {
  test("best score first, ties to the newest; at most two of one owner near the top, the third after it", () => {
    const items = [
      { id: "a1", owner: "ann", score: 9 },
      { id: "a2", owner: "ann", score: 8 },
      { id: "a3", owner: "ann", score: 7 },
      { id: "b1", owner: "bo", score: 1 },
      { id: "c2", owner: "cy", score: 1 },
    ];
    expect(rankFront(items).map((i) => i.id)).toEqual([
      "a1",
      "a2",
      // c2 and b1 tie: the newer id first.
      "c2",
      "b1",
      // ann's third waits for the top to fill — here, the end.
      "a3",
    ]);
  });

  test("one owner with many apps takes two of the top places; the others go first, as far as there are others", () => {
    const many = Array.from({ length: 12 }, (_, n) => ({
      id: `t${String(n).padStart(2, "0")}`,
      owner: n < 10 ? "trevato" : `other${n}`,
      score: 100 - n,
    }));
    const order = rankFront(many).map((i) => i.id);
    expect(order.slice(0, 4)).toEqual(["t00", "t01", "t10", "t11"]);
    expect(order.slice(4)).toEqual(
      Array.from({ length: 8 }, (_, n) => `t${String(n + 2).padStart(2, "0")}`),
    );
    // With owners enough, one owner never holds more than two of the top.
    const varied = Array.from({ length: 20 }, (_, n) => ({
      id: `v${String(n).padStart(2, "0")}`,
      owner: n < 10 ? "trevato" : `o${n}`,
      score: 100 - n,
    }));
    const top = rankFront(varied).slice(0, NEAR_TOP);
    expect(top.filter((i) => i.owner === "trevato")).toHaveLength(2);
  });

  test("a score counts forks most, then ships, use and freshness, which fades over the window", () => {
    const fresh = {
      ...none,
      shippedAt: new Date(NOW - 86_400_000).toISOString(),
    };
    const stale = {
      ...none,
      shippedAt: new Date(NOW - 40 * 86_400_000).toISOString(),
    };
    expect(frontScore(none, NOW)).toBe(0);
    expect(frontScore(stale, NOW)).toBe(0);
    expect(frontScore(fresh, NOW)).toBeGreaterThan(1.9);
    expect(frontScore({ ...none, forks: 1 }, NOW)).toBeGreaterThan(
      frontScore({ ...none, ships: 1 }, NOW),
    );
    expect(frontScore({ ...none, ships: 1 }, NOW)).toBeGreaterThan(
      frontScore({ ...none, awakeHours: 1 }, NOW),
    );
  });
});

describe("the front page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let admin: User;
  let member: User;
  let other: User;
  let adminToken: string;
  let memberToken: string;
  let runtime: AppsRuntime;
  const states = new Map<string, EnvState>();
  let restore: () => void;

  const make = async (
    owner: User,
    name: string,
    o: { visibility?: "public" | "private"; picture?: boolean } = {},
  ): Promise<{ repo: Repo; record: AppRecord }> => {
    const made = await createRepo(app, owner, {
      name,
      visibility: o.visibility ?? "public",
      description: `the ${name} app`,
    });
    if (!made.ok) throw new Error(String(made.error));
    const record = insertApp(app.db, {
      repoId: made.value.id,
      slug: name,
      access: "public",
    });
    if (!record.ok) throw new Error(record.error);
    states.set(record.value.id, "running");
    if (o.picture !== false)
      recordLook(app.db, {
        appId: record.value.id,
        env: "production",
        commitOid: "a".repeat(40),
        kind: "thumb",
        path: `looks/${record.value.id}/thumb.png`,
      });
    return { repo: made.value, record: record.value };
  };

  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "front_page", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  const door = async (cookie = "") =>
    (
      await fetch(`${base}/`, { headers: cookie === "" ? {} : { cookie } })
    ).text();

  const put = (token: string | null, body: unknown) =>
    fetch(`${base}/api/v1/front`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-front-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const user = async (username: string) => {
      const made = await createUser(app.db, {
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    admin = await user("owner");
    member = await user("mia");
    other = await user("zed");
    adminToken = createToken(app.db, admin.id, "rw", "rw").token;
    memberToken = createToken(app.db, member.id, "rw", "rw").token;
    // A runtime registered for this forge, never started, answering each
    // app's production from `states`.
    runtime = new AppsRuntime(app, {
      domain: "front.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    const status = spyOn(AppsRuntime.prototype, "status").mockImplementation(
      (record: AppRecord): EnvStatus[] => [
        {
          env: "production",
          state: states.get(record.id) ?? "stopped",
        } as EnvStatus,
      ],
    );
    restore = () => status.mockRestore();
  }, 30_000);

  afterAll(async () => {
    restore();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("signals come from the database: awake hours, merged pulls and production deploys in 30 days, forks", async () => {
    const { repo } = await make(admin, "signal");
    const fork = await createRepo(app, other, {
      name: "signal-fork",
      visibility: "public",
    });
    if (!fork.ok) throw new Error(String(fork.error));
    app.db
      .query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`)
      .run(repo.id, fork.value.id);
    app.db
      .query(
        `INSERT INTO meter (repo_id, env, placement, started_at, beat_at, ended_at)
         VALUES (?1, 'production', 'owned', ?2, ?3, ?3)`,
      )
      .run(repo.id, "2026-10-04T10:00:00.000Z", "2026-10-04T13:00:00.000Z");
    const deploy = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
    });
    claimRun(app.db, deploy.id);
    finishRun(app.db, deploy.id, { state: "ok", summary: "" });
    const signals = frontSignals(app.db, [repo.id], NOW).get(repo.id)!;
    expect(signals.forks).toBe(1);
    expect(signals.awakeHours).toBeCloseTo(3, 5);
    expect(signals.shippedAt).not.toBeNull();
    expect(signals.ships).toBe(0);
    app.db.query(`DELETE FROM app WHERE repo_id = ?1`).run(repo.id);
  });

  test("a stranger and a plain member never set the front page: API, page and MCP", async () => {
    await make(admin, "shown");
    expect((await put(null, { pinned: ["owner/shown"] })).status).toBe(401);
    expect((await put(memberToken, { pinned: ["owner/shown"] })).status).toBe(
      403,
    );
    const memberCookie = await signIn("mia");
    const posted = await fetch(`${base}/front`, {
      method: "POST",
      headers: { cookie: memberCookie, origin: base },
      body: new URLSearchParams({ action: "pin", repo: "owner/shown" }),
      redirect: "manual",
    });
    expect(posted.status).toBe(403);
    const told = await mcp(memberToken, {
      pinned: ["owner/shown"],
      dryRun: false,
    });
    expect(told.error).toContain("forbidden");
    // Nothing was set, and nobody but a site admin is shown the picks.
    const read = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(read.picks).toBeUndefined();
    const asMember = await mcp(memberToken, {});
    expect(asMember.value.picks).toBeUndefined();
    const asAdmin = await mcp(adminToken, {});
    expect(asAdmin.value.picks).toEqual({ pinned: [], hidden: [] });
  });

  test("ranked, not one owner's: forks lift a stranger's app; stopped, failed and unpictured apps are not shown", async () => {
    const forked = await make(other, "loved");
    for (let n = 0; n < 3; n++) {
      const f = await createRepo(app, member, {
        name: `loved-${n}`,
        visibility: "public",
      });
      if (!f.ok) throw new Error(String(f.error));
      app.db
        .query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`)
        .run(forked.repo.id, f.value.id);
    }
    for (const name of ["one", "two", "three"]) await make(admin, name);
    const down = await make(admin, "down");
    states.set(down.record.id, "failed");
    await make(admin, "bare", { picture: false });
    await make(admin, "hush", { visibility: "private" });
    forgetFrontScores(app);
    const body = await door();
    // The most-forked app is featured — a stranger's, ahead of the owner's.
    const featured = body.slice(
      body.indexOf('class="front-featured"'),
      body.indexOf("</section>", body.indexOf('class="front-featured"')),
    );
    expect(featured).toContain('href="/zed/loved"');
    expect(body).not.toContain('href="/owner/down"');
    expect(body).not.toContain('href="/owner/bare"');
    expect(body).not.toContain("hush");
    // The shelf's tiles are the stranger's picture, at the thumb's size.
    expect(body).toContain('width="640"');
    const json = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(json.featured.repo).toBe("zed/loved");
    expect(json.featured.signals.forks).toBe(3);
    expect(json.apps.every((a: any) => !a.repo.endsWith("/hush"))).toBe(true);
  });

  test("a site admin pins, orders and hides; the first pin a stranger can read is featured, a private pin never shows", async () => {
    // The forge's own repository, still private: pinned first, shown never.
    const own = await createRepo(app, admin, {
      name: "forge",
      visibility: "private",
      description: "the forge itself, unreleased",
    });
    if (!own.ok) throw new Error(String(own.error));
    const set = await put(adminToken, {
      pinned: ["owner/forge", "owner/three", "owner/two"],
      hidden: ["zed/loved"],
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({
      pinned: ["owner/forge", "owner/three", "owner/two"],
      hidden: ["zed/loved"],
    });
    const body = await door();
    expect(body).not.toContain('href="/owner/forge"');
    expect(body).not.toContain("the forge itself, unreleased");
    expect(body).not.toContain('href="/zed/loved"');
    const json = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(json.featured.repo).toBe("owner/three");
    expect(json.apps[0].repo).toBe("owner/two");
    expect(json.picks).toBeUndefined();

    // Made public, the forge itself is featured.
    app.db
      .query(`UPDATE repo SET visibility = 'public' WHERE id = ?1`)
      .run(own.value.id);
    expect(
      ((await (await fetch(`${base}/api/v1/front`)).json()) as any).featured
        .repo,
    ).toBe("owner/forge");
    app.db
      .query(`UPDATE repo SET visibility = 'private' WHERE id = ?1`)
      .run(own.value.id);

    // Refused: a name that is no repository, one both pinned and hidden.
    expect((await put(adminToken, { pinned: ["owner/nope"] })).status).toBe(
      422,
    );
    expect(
      (await put(adminToken, { pinned: ["owner/two"], hidden: ["owner/two"] }))
        .status,
    ).toBe(422);

    // The page itself: /front gives a site admin the controls, and a move
    // there is the same setting.
    const cookie = await signIn("owner");
    const page = await (
      await fetch(`${base}/front`, { headers: { cookie } })
    ).text();
    expect(page).toContain("The front page");
    expect(page).toContain("owner/forge");
    const moved = await fetch(`${base}/front`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ action: "up", repo: "owner/two" }),
      redirect: "manual",
    });
    expect(moved.status).toBe(303);
    const picks = (await mcp(adminToken, {})).value.picks;
    expect(picks.pinned).toEqual(["owner/forge", "owner/two", "owner/three"]);
    // A stranger at /front sees the page, never the controls.
    const strangers = await (await fetch(`${base}/front`)).text();
    expect(strangers).not.toContain("The front page</h2>");
    expect(strangers).not.toContain("owner/forge");

    // MCP: a dry run checks and changes nothing; dryRun false sets.
    const dry = await mcp(adminToken, { hidden: [] });
    expect(dry.value.dryRun).toBe(true);
    expect((await mcp(adminToken, {})).value.picks.hidden).toEqual([
      "zed/loved",
    ]);
    const wet = await mcp(adminToken, { hidden: [], dryRun: false });
    expect(wet.value.picks.hidden).toEqual([]);
  });

  test("featured shows the crew at work on it right now, by issue", async () => {
    const issue = openIssue(
      app,
      admin,
      getRepo(app.db, "owner", "two")!,
      {
        title: "Make the board faster",
      },
    );
    if (!issue.ok) throw new Error(String(issue.error));
    expect(
      (await put(adminToken, { pinned: ["owner/two"], hidden: [] })).status,
    ).toBe(200);
    const run = createRun(app.db, {
      repoId: issue.value.repoId,
      kind: "agent",
      issueId: issue.value.id,
    });
    claimRun(app.db, run.id);
    const body = await door();
    expect(body).toContain("The crew is at work: 1 agent right now");
    expect(body).toContain("Make the board faster");
    const json = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(json.featured.crew).toEqual({
      running: 1,
      issues: [{ number: issue.value.number, title: "Make the board faster" }],
    });
  });
});
