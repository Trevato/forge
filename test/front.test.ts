/**
 * The front page (#686): the forge featured with its crew at work, the best
 * of what is public ranked by real signals with at most two per owner near
 * the top, and a site admin's pins and hides — on the page, the API and the
 * MCP alike. Refusals first: a stranger and a plain member never set it, and
 * nothing private is ever shown, pinned or not.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { suspendAccount } from "../src/actions/accounts.ts";
import { forgetFrontScores, frontPage } from "../src/actions/front.ts";
import * as lookService from "../src/looks/service.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { changeSignup } from "../src/actions/signup.ts";
import {
  AppsRuntime,
  type EnvState,
  type EnvStatus,
  type LiveEnv,
} from "../src/apps/runtime.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import {
  DEFAULT_WEIGHTS,
  frontScore,
  frontWeights,
  frontSignals,
  NEAR_TOP,
  rankFront,
  type FrontSignals,
} from "../src/core/front.ts";
import { recordLook } from "../src/core/looks.ts";
import { encodePng } from "../src/design/image/png.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startLooks } from "../src/looks/service.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const NOW = Date.parse("2026-10-05T12:00:00Z");
/** Every app's production serves this commit, and its thumb is of it. */
const HEAD = "a".repeat(40);
/** A thumb's stand-in file: one pixel, not the legacy 200 px width. */
const PNG = Buffer.from(
  encodePng(1, 1, new Uint8Array([255, 255, 255, 255])),
);
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
  const woken: string[] = [];
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
    if (o.picture !== false) {
      mkdirSync(join(dataDir, "looks", record.value.id), { recursive: true });
      writeFileSync(join(dataDir, "looks", record.value.id, "thumb.png"), PNG);
      recordLook(app.db, {
        appId: record.value.id,
        env: "production",
        commitOid: HEAD,
        kind: "thumb",
        path: `looks/${record.value.id}/thumb.png`,
      });
    }
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
      const made = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        // Fixtures may name an account after a reserved word on purpose.
        allowReserved: true,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      promote(app.db, made.value);
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
          commitOid: HEAD,
        } as EnvStatus,
      ],
    );
    const one = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      (record: AppRecord): EnvStatus =>
        ({
          env: "production",
          state: states.get(record.id) ?? "stopped",
          commitOid: HEAD,
        }) as EnvStatus,
    );
    // Waking an app is what the looks sweep asks of a pinned app asleep
    // without a picture: here it simply comes up.
    const wake = spyOn(AppsRuntime.prototype, "wake").mockImplementation(
      async (record: AppRecord) => {
        woken.push(record.slug);
        states.set(record.id, "running");
        return { env: "production", commitOid: HEAD } as LiveEnv;
      },
    );
    restore = () => {
      status.mockRestore();
      one.mockRestore();
      wake.mockRestore();
    };
  }, 30_000);

  afterAll(async () => {
    restore();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("signals come from the database: awake hours and merged pulls in 30 days, the last merge, and forks by people, not agents", async () => {
    const { repo } = await make(admin, "signal");
    const fork = await createRepo(app, other, {
      name: "signal-fork",
      visibility: "public",
    });
    if (!fork.ok) throw new Error(String(fork.error));
    app.db
      .query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`)
      .run(repo.id, fork.value.id);
    // A private fork is its owner's to tell of: not counted.
    const hidden = await createRepo(app, other, {
      name: "signal-private-fork",
      visibility: "private",
    });
    if (!hidden.ok) throw new Error(String(hidden.error));
    app.db
      .query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`)
      .run(repo.id, hidden.value.id);
    // An agent's working fork is how the crew builds, not a fork.
    const agentFork = await createRepo(app, member, {
      name: "signal-agent-fork",
      visibility: "public",
    });
    if (!agentFork.ok) throw new Error(String(agentFork.error));
    app.db.query(`UPDATE user SET is_agent = 1 WHERE id = ?1`).run(member.id);
    app.db
      .query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`)
      .run(repo.id, agentFork.value.id);
    app.db
      .query(
        `INSERT INTO meter (repo_id, env, placement, started_at, beat_at, ended_at)
         VALUES (?1, 'production', 'owned', ?2, ?3, ?3)`,
      )
      .run(repo.id, "2026-10-04T10:00:00.000Z", "2026-10-04T13:00:00.000Z");
    const merged = (at: string) => {
      const made = createIssue(app.db, {
        repoId: repo.id,
        authorId: admin.id,
        title: `a change at ${at}`,
        kind: "pull",
      });
      if (!made.ok) throw new Error(made.error);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
           VALUES (?1, 'main', ?2, '', '', ?3)`,
        )
        .run(made.value.id, `b-${at}`, at);
    };
    merged("2026-10-03T09:00:00.000Z");
    merged("2026-08-01T09:00:00.000Z"); // outside the window: not a ship now
    const signals = frontSignals(app.db, [repo.id], NOW).get(repo.id)!;
    expect(signals.forks).toBe(1);
    // The repository's own Forks tab counts what the reader may see: a
    // stranger is not told the private fork exists (nor the agent's,
    // which is public here and so counts).
    const nav = await (
      await fetch(`${base}/owner/signal/forks`, { headers: { cookie: "forge_mode=dev" } })
    ).text();
    const tab = nav.slice(nav.indexOf('href="/owner/signal/forks"'), nav.indexOf("</a>", nav.indexOf('href="/owner/signal/forks"')));
    expect(tab).toContain(">2<");
    expect(tab).not.toContain(">3<");
    expect(signals.awakeHours).toBeCloseTo(3, 5);
    expect(signals.ships).toBe(1);
    expect(signals.shippedAt).toBe("2026-10-03T09:00:00.000Z");
    app.db.query(`UPDATE user SET is_agent = 0 WHERE id = ?1`).run(member.id);
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
    expect(asAdmin.value.picks).toEqual({ pinned: [], hidden: [], weights: DEFAULT_WEIGHTS });
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
    // A public repository whose app only signed-in readers may open: a
    // stranger would meet a sign-in page, so it is not offered to them.
    const gated = await make(admin, "gated");
    app.db.query(`UPDATE app SET access = 'private' WHERE id = ?1`).run(gated.record.id);
    // A thumb from before thumbs were taken as a stranger (200 px, the
    // owner's view), and a thumb of a commit production no longer serves:
    // neither is shown, so neither app is.
    const legacy = await make(admin, "legacy");
    writeFileSync(
      join(dataDir, "looks", legacy.record.id, "thumb.png"),
      Buffer.from(encodePng(200, 125, new Uint8Array(200 * 125 * 4))),
    );
    const moved = await make(admin, "moved");
    app.db
      .query(`UPDATE look SET commit_oid = ?1 WHERE app_id = ?2`)
      .run("b".repeat(40), moved.record.id);
    forgetFrontScores(app);
    const body = await door();
    // The most-forked app is featured — a stranger's, ahead of the owner's.
    const start = body.indexOf('aria-label="Featured"');
    expect(start).toBeGreaterThan(-1);
    const next = body.indexOf('class="card', start);
    const featured = body.slice(start, next === -1 ? undefined : next);
    expect(featured).toContain('href="/zed/loved/app/production/open"');
    expect(body).not.toContain('href="/owner/down"');
    expect(body).not.toContain('href="/owner/bare"');
    expect(body).not.toContain("hush");
    expect(body).not.toContain('href="/owner/gated"');
    expect(body).not.toContain('href="/owner/legacy"');
    expect(body).not.toContain('href="/owner/moved"');
    // The shelf's tiles are the stranger's picture, at the thumb's size.
    expect(body).toContain('width="640"');
    // The tiles are §5's card and look, not the page's own classes; the name
    // still links, the picture still links, and the words are there.
    for (const old of ["app-tile", "app-tile-body", "app-tile-desc", "app-tile-look", "app-tile-name"])
      expect(body).not.toContain(old);
    const shelf = body.slice(body.indexOf(' data-shelf'));
    expect(shelf).toMatch(/<div\s+class="card"/);
    // The picture opens the app; the name leads to its repository.
    expect(shelf).toMatch(/<a\s+class="look"\s+href="\/owner\/one\/app\/production\/open"/);
    expect(shelf).toMatch(/<a href="\/owner\/one"><strong>one<\/strong><\/a>/);
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
      weights: DEFAULT_WEIGHTS,
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
    // A body naming neither list is a mistake, not "no change".
    expect((await put(adminToken, { pin: ["owner/two"] })).status).toBe(422);
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



  test("the door shows the pins alone, in order, each with its doors, and says what a closed forge offers", async () => {
    await make(admin, "door-first");
    await make(admin, "door-second");
    expect((await put(adminToken, { pinned: ["owner/door-second", "owner/door-first"], hidden: [] })).status).toBe(200);
    const shelf = (b: string) => b.slice(b.indexOf(" data-shelf"), b.indexOf('id="door-end"') === -1 ? undefined : b.indexOf('id="door-end"'));
    const open = await door();
    const tiles = shelf(open);
    expect(tiles.indexOf("door-second")).toBeLessThan(tiles.indexOf("door-first"));
    expect(tiles.match(/class="card"/g)?.length).toBe(2);
    expect(tiles).toContain('href="/owner/door-second/app/production/open"');
    expect(tiles).toContain(`href="/signup?next=${encodeURIComponent("/owner/door-second")}"`);
    expect(tiles).toContain(">Help build this<");
    const set = changeSignup(app, admin, "invite");
    expect(set.ok).toBe(true);
    const closed = await door();
    expect(closed).toContain('href="/owner/door-second/report"');
    expect(closed).toContain(">Suggest a change<");
    expect(closed).not.toContain("Help build this");
    expect(closed).toContain("New accounts on this forge are by invitation.");
    changeSignup(app, admin, "open");
    expect((await put(adminToken, { pinned: [], hidden: [] })).status).toBe(200);
  });
  test("the door lists merges on public repositories only, and never a sealed one", async () => {
    const merged = (repoId: string, title: string, sealed = false) => {
      const issue = createIssue(app.db, { repoId, authorId: admin.id, title, body: "" });
      if (!issue.ok) throw new Error(issue.error);
      if (sealed) app.db.query("UPDATE issue SET sealed = 1 WHERE id = ?1").run(issue.value.id);
      const cols = app.db.query("PRAGMA table_info(pull)").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[];
      const row: Record<string, string | number> = {
        issue_id: issue.value.id,
        merged_at: new Date().toISOString(),
      };
      for (const c of cols)
        if (!(c.name in row) && c.notnull === 1 && c.dflt_value === null)
          row[c.name] = c.type.includes("INT") ? 0 : crypto.randomUUID();
      const names = Object.keys(row);
      app.db
        .query(`INSERT INTO pull (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .run(...names.map((k) => row[k]!));
    };
    const shown = await make(admin, "door-public");
    const hidden = await make(admin, "door-private", { visibility: "private" });
    merged(shown.repo.id, "A merge anyone may read");
    merged(shown.repo.id, "A sealed merge", true);
    merged(hidden.repo.id, "A merge nobody outside may read");
    forgetFrontScores(app);
    const body = await door();
    expect(body).toContain("A merge anyone may read");
    expect(body).not.toContain("A sealed merge");
    expect(body).not.toContain("A merge nobody outside may read");
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
    expect(body).toContain(`href="/owner/two/issues/${issue.value.number}"`);
    for (const old of ["front-crew", "front-live", "front-issues", "front-more"])
      expect(body).not.toContain(old);
    const json = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(json.featured.crew).toEqual({
      running: 1,
      issues: [{ number: issue.value.number, title: "Make the board faster" }],
    });
  });

  test("never a letter tile: a pin without a stranger's picture, or one that is down, waits; the sweep wakes a pinned app asleep to picture it", async () => {
    await make(admin, "pinned-bare", { picture: false });
    const down = await make(admin, "pinned-down");
    states.set(down.record.id, "failed");
    const sleepy = await make(admin, "pinned-sleepy", { picture: false });
    states.set(sleepy.record.id, "asleep");
    expect(
      (
        await put(adminToken, {
          pinned: ["owner/two", "owner/pinned-bare", "owner/pinned-down", "owner/pinned-sleepy"],
          hidden: [],
        })
      ).status,
    ).toBe(200);
    const body = await door();
    for (const name of ["pinned-bare", "pinned-down", "pinned-sleepy"])
      expect(body).not.toContain(`href="/owner/${name}"`);
    expect(body).not.toContain("app-tile-blank");

    // The sweep wakes the pinned app asleep without a picture, and its
    // picture is taken as nobody; then it takes its place.
    const looks = startLooks(app, {
      localUrl: servers.url,
      capture: async (input) => {
        writeFileSync(input.out, Buffer.from(encodePng(4, 4, new Uint8Array(64).fill(255))));
        return { ok: true, value: { entries: {} } };
      },
    });
    try {
      looks.sweep();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !(await door()).includes('href="/owner/pinned-sleepy"'))
        await Bun.sleep(100);
      expect(woken).toContain("pinned-sleepy");
      // Not woken: a pin with a picture, a pin already up.
      expect(woken).not.toContain("two");
      expect(await door()).toContain('href="/owner/pinned-sleepy"');
    } finally {
      await looks.stop();
    }
  }, 60_000);

  test("a pinned repository whose app is private tells a stranger neither the app's state nor its hours awake, on the API and MCP, and is featured whatever its state", async () => {
    const gated = await make(other, "gated-pin");
    app.db.query(`UPDATE app SET access = 'private' WHERE id = ?1`).run(gated.record.id);
    states.set(gated.record.id, "failed");
    app.db
      .query(
        `INSERT INTO meter (repo_id, env, placement, started_at, beat_at, ended_at)
         VALUES (?1, 'production', 'owned', ?2, ?3, ?3)`,
      )
      .run(gated.repo.id, new Date(Date.now() - 5 * 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString());
    expect((await put(adminToken, { pinned: ["zed/gated-pin"], hidden: [] })).status).toBe(200);
    forgetFrontScores(app);
    const anonymous = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(anonymous.featured.repo).toBe("zed/gated-pin");
    expect(anonymous.featured.state).toBeNull();
    expect(anonymous.featured.signals.awakeHours).toBe(0);
    expect(anonymous.featured.picture).toBeNull();
    const told = (await mcp(memberToken, {})).value;
    expect(told.featured.repo).toBe("zed/gated-pin");
    expect(told.featured.state).toBeNull();
    expect(told.featured.signals.awakeHours).toBe(0);
    const body = await door();
    expect(body).not.toContain("Failed");
    // The same pin's state, for an app strangers can open, is told.
    app.db.query(`UPDATE app SET access = 'public' WHERE id = ?1`).run(gated.record.id);
    states.set(gated.record.id, "running");
    forgetFrontScores(app);
    const opened = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(opened.featured.state).toBe("running");
    expect(opened.featured.signals.awakeHours).toBeGreaterThan(3);
  });

  test("a suspended account's app is not on the front page, ranked or pinned", async () => {
    const sus = await createUser(app.db, {
      origin: "seed",
      username: "suspended-maker",
      email: "suspended-maker@forge.local",
      password: "a-good-passphrase",
    });
    if (!sus.ok) throw new Error(sus.error);
    proveAll(app);
    promote(app.db, sus.value);
    await make(sus.value, "sus-app");
    expect((await put(adminToken, { pinned: ["suspended-maker/sus-app"], hidden: [] })).status).toBe(200);
    forgetFrontScores(app);
    expect(await door()).toContain('href="/suspended-maker/sus-app"');
    expect((await suspendAccount(app, admin, "suspended-maker")).ok).toBe(true);
    forgetFrontScores(app);
    const body = await door();
    expect(body).not.toContain('href="/suspended-maker/sus-app"');
    const json = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(JSON.stringify(json)).not.toContain("suspended-maker/sus-app\"");
    expect(json.featured?.repo).not.toBe("suspended-maker/sus-app");
  });

  test("the page's memory of which thumbs were taken as a stranger keeps only the pictures it shows, however often they are retaken (#768)", async () => {
    const { repo, record } = await make(admin, "retaken");
    const reads = spyOn(lookService, "keepLook");
    try {
      frontPage(app);
      // A picture already checked is not read again.
      reads.mockClear();
      frontPage(app);
      expect(reads.mock.calls.filter(([, l]) => l.appId === record.id)).toHaveLength(0);
      const retake = (n: number) => {
        const path = `looks/${record.id}/thumb-${n}.png`;
        mkdirSync(join(dataDir, "looks", record.id), { recursive: true });
        writeFileSync(join(dataDir, path), PNG);
        recordLook(app.db, {
          appId: record.id,
          env: "production",
          commitOid: HEAD,
          kind: "thumb",
          path,
        });
      };
      for (let n = 0; n < 25; n++) {
        retake(n);
        reads.mockClear();
        const shown = frontPage(app);
        // The new picture is read once…
        expect(reads.mock.calls.filter(([, l]) => l.appId === record.id)).toHaveLength(1);
        expect(JSON.stringify(shown)).toContain(`/${repo.ownerName}/${repo.name}/looks/`);
      }
      // …and the ones it replaced were forgotten: shown again, the first is
      // read afresh, not answered from a memory that kept every path.
      retake(0);
      reads.mockClear();
      frontPage(app);
      expect(reads.mock.calls.filter(([, l]) => l.appId === record.id)).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  });

  test("the ranking's weights are a site admin's alone: a stranger and a plain member are refused on the API, the page and MCP, and are not shown them (#767)", async () => {
    expect((await put(null, { weights: { forks: 0 } })).status).toBe(401);
    expect((await put(memberToken, { weights: { forks: 0 } })).status).toBe(403);
    const memberCookie = await signIn("mia");
    const posted = await fetch(`${base}/front`, {
      method: "POST",
      headers: { cookie: memberCookie, origin: base },
      body: new URLSearchParams({ action: "weights", forks: "0", ships: "0", use: "0", fresh: "0" }),
      redirect: "manual",
    });
    expect(posted.status).toBe(403);
    expect((await mcp(memberToken, { weights: { forks: 0 }, dryRun: false })).error).toContain("forbidden");
    expect(frontWeights(app.db)).toEqual(DEFAULT_WEIGHTS);
    const anonymous = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
    expect(anonymous.picks).toBeUndefined();
    expect(JSON.stringify(anonymous)).not.toContain('"weights"');
  });

  test("a site admin's weights change the order, within bounds; a value out of bounds is refused (#767)", async () => {
    // One app with forks by people, one with ships: which leads depends on
    // what counts.
    const forked = await make(other, "weighed-forks");
    const forkerA = await createUser(app.db, { origin: "seed", trusted: true, username: "forker-a", email: "fa@forge.local", password: "a-good-passphrase" });
    if (!forkerA.ok) throw new Error(forkerA.error);
    promote(app.db, forkerA.value);
    const forkA = await createRepo(app, forkerA.value, { name: "my-weighed", visibility: "public" });
    if (!forkA.ok) throw new Error(String(forkA.error));
    app.db.query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`).run(forked.repo.id, forkA.value.id);
    const shipped = await make(other, "weighed-ships");
    for (let n = 0; n < 6; n++) {
      const issue = createIssue(app.db, { repoId: shipped.repo.id, authorId: other.id, title: `ship ${n}`, kind: "pull" });
      if (!issue.ok) throw new Error(issue.error);
      app.db
        .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', '', ?3)`)
        .run(issue.value.id, `s${n}`, new Date(Date.now() - 2 * 86_400_000).toISOString());
    }
    const order = async () => {
      forgetFrontScores(app);
      const json = (await (await fetch(`${base}/api/v1/front`)).json()) as any;
      const names: string[] = [json.featured?.repo, ...json.apps.map((a: any) => a.repo)];
      return [names.indexOf("zed/weighed-forks"), names.indexOf("zed/weighed-ships")] as const;
    };
    expect((await put(adminToken, { pinned: [], hidden: [] })).status).toBe(200);
    // Ships alone count: the shipped app leads.
    const ships = await put(adminToken, { weights: { forks: 0, ships: 10, use: 0, fresh: 0 } });
    expect(ships.status).toBe(200);
    expect(((await ships.json()) as any).weights).toEqual({ forks: 0, ships: 10, use: 0, fresh: 0 });
    const shipsFirst = await order();
    expect(shipsFirst[1]).toBeLessThan(shipsFirst[0]);
    // Forks alone count: the forked app leads. One weight given keeps the rest.
    expect((await put(adminToken, { weights: { forks: 10, ships: 0 } })).status).toBe(200);
    expect(frontWeights(app.db)).toEqual({ forks: 10, ships: 0, use: 0, fresh: 0 });
    const forksFirst = await order();
    expect(forksFirst[0]).toBeLessThan(forksFirst[1]);
    // Out of bounds, or not a number: refused, and nothing changes.
    for (const bad of [{ forks: 11 }, { ships: -1 }, { use: "a lot" }]) {
      expect((await put(adminToken, { weights: bad })).status).toBe(422);
    }
    expect(frontWeights(app.db)).toEqual({ forks: 10, ships: 0, use: 0, fresh: 0 });
    // The admin sees them; the page's controls say them; and they go back.
    const asAdmin = (await mcp(adminToken, {})).value;
    expect(asAdmin.picks.weights).toEqual({ forks: 10, ships: 0, use: 0, fresh: 0 });
    const cookie = await signIn("owner");
    const page = await (await fetch(`${base}/front`, { headers: { cookie } })).text();
    expect(page).toMatch(/name="forks"\s+value="10"/);
    const reset = await fetch(`${base}/front`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ action: "weights", forks: "3", ships: "2", use: "1", fresh: "2" }),
      redirect: "manual",
    });
    expect(reset.status).toBe(303);
    expect(frontWeights(app.db)).toEqual(DEFAULT_WEIGHTS);
  });
});
