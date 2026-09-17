/**
 * The studio: apps as the unit, three verbs, and a switch to dev. The same
 * URLs answer in both modes; the cookie decides which face they show.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import type { EnvName } from "../src/apps/data.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getIssue, listIssues } from "../src/core/issues.ts";
import { recordLook } from "../src/core/looks.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import type { Decider } from "../src/crew/decide.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pendingLeans } from "../src/web/pages/studio.ts";

/** One transparent pixel, dropped where a look would sit. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("the studio", () => {
  test("the asks script posts to the form's action attribute: a control named action shadows form.action", async () => {
    const { asksJs } = await import("../src/web/client.ts");
    expect(asksJs).not.toContain("form.action,");
    expect(asksJs).toContain("getAttribute('action')");
  });

  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;

  const get = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio`, ...extra },
      redirect: "manual",
    });
  const post = (path: string, body: Record<string, string>, extra = "") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: `${cookie}${extra}`, origin: base },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "private",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"notes","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("home is the studio with the cookie and the repositories without; the switch is a cookie", async () => {
    const plain = await (
      await fetch(`${base}/`, { headers: { cookie } })
    ).text();
    expect(plain).not.toContain("<h1>Studio</h1>");
    const home = await (await get("/")).text();
    expect(home).toContain("Studio");
    expect(home).toContain("notes");
    expect(home).toContain("New app");
    const dev = await (await get("/?mode=dev")).text();
    expect(dev).not.toContain("<h1>Studio</h1>");
    const flipped = await post("/mode", { mode: "dev", back: "/" });
    expect(flipped.status).toBe(303);
    expect(flipped.headers.get("set-cookie")).toContain("forge_mode=dev");
    const asDev = await (
      await get("/", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(asDev).not.toContain("<h1>Studio</h1>");
    const bad = await post("/mode", { mode: "neither", back: "/" });
    expect(bad.headers.get("set-cookie")).toContain("forge_mode=;");
  });

  test("an app's home is the app in the studio, and the code in dev", async () => {
    const studio = await (await get("/alice/notes")).text();
    expect(studio).toContain("Tell the crew");
    expect(studio).toContain("<h2>Crew</h2>");
    expect(studio).toContain(">Studio<");
    expect(studio).not.toContain(">Commits<");
    const dev = await (
      await get("/alice/notes", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).not.toContain("Tell the crew");
    expect(dev).toContain(">Commits<");
  });

  test("telling the crew opens an issue and hands it to a builder", async () => {
    const told = await post("/alice/notes/tell", {
      text: "Make the notes page load in under a second on my phone.\n\nIt takes three seconds now.",
    });
    expect(told.status).toBe(303);
    const issue = listIssues(app.db, repo.id, { kind: "issue", limit: 5 })[0]!;
    expect(issue.title).toBe(
      "Make the notes page load in under a second on my phone.",
    );
    expect(issue.body).toContain("three seconds");
    expect(issue.assigneeName).toBe("scout");
    const again = await (await get("/alice/notes")).text();
    expect(again).toContain("waiting");
    expect(again).toContain(">scout<");
    const empty = await post("/alice/notes/tell", { text: "   " });
    expect(empty.status).toBe(303);
  });

  test("ship lands a change; say tells the crew", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: "main",
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Faster",
      body: "Closes #1",
      baseBranch: "main",
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const said = await post(`/alice/notes/pulls/${pull.number}/say`, {
      text: "Keep the images lazy too.",
    });
    expect(said.status).toBe(303);
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed in 1s" });
    // A bare POST — a button with no fields, or a client that sent no body
    // at all — ships too: an empty form is not a bad request.
    const shipped = await fetch(
      `${base}/alice/notes/pulls/${pull.number}/ship`,
      {
        method: "POST",
        headers: { cookie: `${cookie}; forge_mode=studio`, origin: base },
        redirect: "manual",
      },
    );
    expect(shipped.status).toBe(303);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(getIssue(app.db, repo.id, 1)?.state).toBe("closed");
    const page = await (await get("/alice/notes")).text();
    expect(page).toContain("shipped");
    // What was told and then shipped is not still "waiting" in Now.
    expect(page).not.toContain(">waiting<");
    expect(getUserByName(app.db, "scout")).toBeDefined();
  });

  test("several asks, one decision: a box per ask, one bar, one post; in place when asked for JSON", async () => {
    const scout = getUserByName(app.db, "scout")!;
    // The crew proposes: a pull by scout on its own branch.
    const ask = async (name: string): Promise<Pull> => {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `ask/${name}`,
        base: "main",
        message: `Ask ${name}`,
        files: [{ path: `${name}.md`, content: `${name}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, scout, repo, {
        title: `Ask ${name}`,
        body: "",
        baseBranch: "main",
        headBranch: `ask/${name}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    };
    const check = (pull: Pull, state: "ok" | "failed") => {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.id,
        env: `pull-${pull.number}`,
        commitOid: pull.headOid,
        reason: "pull",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state, summary: `check ${state}` });
    };
    const a = await ask("a");
    const b = await ask("b");
    const c = await ask("c");
    const d = await ask("d");
    check(a, "ok");
    check(b, "ok");
    check(d, "ok");
    // c: red, and the crew tried its limit since anyone spoke — it stopped.
    check(c, "failed");
    await Bun.sleep(5);
    // Each try is over: a run still queued or running would make c the
    // crew's, not a question for a person.
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tried = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: c.id,
        reason: "check_failed",
        actorId: scout.id,
      });
      claimRun(app.db, tried.id);
      finishRun(app.db, tried.id, { state: "failed", summary: "still red" });
    }

    // (a) One box per ask, one form around them, the bar's actions, and a
    // row's own form outside the panel's — never a form in a form.
    const page = await (await get("/alice/notes")).text();
    expect(page.match(/class="studio-ask-pick"/g)?.length).toBe(4);
    expect(page).toContain(`value="look:${a.id}"`);
    expect(page).toContain(`value="stopped:${c.id}"`);
    expect(page).toContain('action="/studio/asks"');
    expect(page).toMatch(/name="action"\s+value="ship"/);
    expect(page).toMatch(/name="action"\s+value="close"/);
    expect(page).toContain(`form="ask-look:${a.id}"`);
    expect(page).toContain(`id="ask-look:${a.id}"`);
    expect(page).toContain(`id="ask-stopped:${c.id}"`);
    const panel = page.slice(page.indexOf('action="/studio/asks"'));
    expect(panel.slice(0, panel.indexOf("</form>"))).not.toContain("<form");

    // (b) One decision for two; the third does not take it and is skipped.
    const bulk = (body: [string, string][], accept?: string) =>
      fetch(`${base}/studio/asks`, {
        method: "POST",
        headers: {
          cookie: `${cookie}; forge_mode=studio`,
          origin: base,
          ...(accept === undefined ? {} : { accept }),
        },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    const shipped = await bulk([
      ["ask", `look:${a.id}`],
      ["ask", `look:${b.id}`],
      ["ask", `stopped:${c.id}`],
      ["action", "ship"],
      ["back", "/alice/notes"],
    ]);
    expect(shipped.status).toBe(303);
    expect(shipped.headers.get("location")).toBe("/alice/notes");
    expect(
      decodeURIComponent(shipped.headers.get("set-cookie") ?? ""),
    ).toContain("Shipped 2 · skipped 1");
    expect(getPull(app.db, repo.id, a.number)?.mergedAt).not.toBeNull();
    expect(getPull(app.db, repo.id, b.number)?.mergedAt).not.toBeNull();
    expect(getPull(app.db, repo.id, c.number)?.state).toBe("open");

    // (c) Asked for JSON, the route says what was done and what was skipped
    // — an ask already decided is skipped, not guessed at.
    const closed = await bulk(
      [
        ["ask", `stopped:${c.id}`],
        ["ask", `look:${a.id}`],
        ["action", "close"],
      ],
      "application/json",
    );
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({
      ok: true,
      flash: "Closed 1 · skipped 1",
      done: [`stopped:${c.id}`],
      skipped: [`look:${a.id}`],
      failed: [],
    });
    expect(getPull(app.db, repo.id, c.number)?.state).toBe("closed");
    const nothing = await bulk(
      [
        ["ask", "look:nothing"],
        ["action", "close"],
      ],
      "application/json",
    );
    expect(nothing.status).toBe(422);
    expect(await nothing.json()).toEqual({
      ok: false,
      error: "Closed 0 · skipped 1",
      done: [],
      skipped: ["look:nothing"],
      failed: [],
    });

    // (d) A row's own button answers the same two ways: JSON when asked,
    // the redirect and flash otherwise.
    const ship = (accept?: string) =>
      fetch(`${base}/alice/notes/pulls/${d.number}/ship`, {
        method: "POST",
        headers: {
          cookie: `${cookie}; forge_mode=studio`,
          origin: base,
          ...(accept === undefined ? {} : { accept }),
        },
        redirect: "manual",
      });
    const inPlace = await ship("application/json");
    expect(inPlace.status).toBe(200);
    expect(await inPlace.json()).toEqual({
      ok: true,
      flash: 'Shipped "Ask d". Production is redeploying.',
    });
    expect(getPull(app.db, repo.id, d.number)?.mergedAt).not.toBeNull();
    const refused = await ship("application/json");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ ok: false });
    const plain = await ship();
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/alice/notes");
    // Nothing asks any more: no box, no panel.
    const after = await (await get("/alice/notes")).text();
    expect(after).not.toContain('class="studio-ask-pick"');
    expect(after).not.toContain('action="/studio/asks"');
  });

  test("signed out in studio, / leads with the public apps that are serving — their look, not a private one's", async () => {
    // A second app, public, with a picture of its production. "notes" stays
    // private, so its presence (or absence) is the negative case below.
    const madePublic = await createRepo(app, alice, {
      name: "beacon",
      visibility: "public",
      description: "a lighthouse in the fog",
    });
    if (!madePublic.ok) throw new Error(String(madePublic.error));
    const beacon = madePublic.value;
    const seededPublic = await commitToBranch(app, alice, beacon, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"beacon","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seededPublic.ok) throw new Error(JSON.stringify(seededPublic.error));
    const enabledPublic = await enableApp(app, alice, beacon, {
      slug: "beacon",
    });
    if (!enabledPublic.ok) throw new Error(String(enabledPublic.error));

    // A look for each app's production, so the picture route has something
    // real to answer for and refuse.
    const dropLook = (appId: string, env: "production", commit: string) => {
      const rel = join("looks", appId, `${env}-desktop.png`);
      const abs = join(app.config.dataDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, PNG);
      return recordLook(app.db, {
        appId,
        env,
        commitOid: commit,
        kind: "desktop",
        path: rel,
      });
    };
    const beaconApp = getAppByRepo(app.db, beacon.id)!;
    const notesApp = getAppByRepo(app.db, repo.id)!;
    dropLook(beaconApp.id, "production", seededPublic.value.commitOid);
    dropLook(notesApp.id, "production", "0".repeat(40));

    // Signed out, with the studio cookie: the public app's name, its look,
    // and Sign in / Create an account — never the private one.
    const anon = await (
      await fetch(`${base}/`, { headers: { cookie: "forge_mode=studio" } })
    ).text();
    expect(anon).toContain("beacon");
    expect(anon).toContain("a lighthouse in the fog");
    expect(anon).toContain(`/looks/production/${seededPublic.value.commitOid}/desktop.png`);
    expect(anon).toContain('href="/signin"');
    expect(anon).toContain('href="/signup"');
    expect(anon).not.toContain(">notes<");
    expect(anon).not.toContain("Your code, your machine");

    // The private app's picture 404s for a stranger — asserted, not assumed.
    const privateLook = await fetch(
      `${base}/alice/notes/looks/production/${"0".repeat(40)}/desktop.png`,
      { headers: { cookie: "forge_mode=studio" } },
    );
    expect(privateLook.status).toBe(404);
    // The public one's does not.
    const publicLook = await fetch(
      `${base}/alice/beacon/looks/production/${seededPublic.value.commitOid}/desktop.png`,
      { headers: { cookie: "forge_mode=studio" } },
    );
    expect(publicLook.status).toBe(200);

    // `?mode=dev` still renders the dev landing, unchanged, for a stranger.
    const dev = await (
      await fetch(`${base}/?mode=dev`, {
        headers: { cookie: "forge_mode=studio" },
      })
    ).text();
    expect(dev).toContain("Your code, your machine");
  });

  test("a forge with no public apps falls back to the dev landing, signed out in studio", async () => {
    const dataDir2 = await mkdtemp(join(tmpdir(), "forge-studio-empty-"));
    const app2 = createApp({ dataDir: dataDir2, port: 0 });
    const servers2 = await serve(app2);
    try {
      const body = await (
        await fetch(`${servers2.url}/`, {
          headers: { cookie: "forge_mode=studio" },
        })
      ).text();
      expect(body).toContain("Your code, your machine");
    } finally {
      servers2.stop();
      app2.close();
      await rm(dataDir2, { recursive: true, force: true });
    }
  });
});

describe("the studio home does not wait on the decider", () => {
  const DECIDER_MS = 800;
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;
  let calls: number;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-lean-"));
    calls = 0;
    const decider: Decider = {
      name: "slow",
      async decide(_state, questions) {
        calls++;
        await Bun.sleep(DECIDER_MS);
        const options = questions["option"]!.options;
        return {
          option: {
            choice: options[0]!,
            p: 0.9,
            probabilities: Object.fromEntries(
              options.map((o, i) => [o, i === 0 ? 0.9 : 0.05]),
            ),
          },
        } as never;
      },
    };
    app = createApp({ dataDir, port: 0, decider });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const made = await createRepo(app, alice, {
      name: "leans",
      visibility: "private",
      description: "for the lean",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"leans","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "leans" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
    const scoutUser = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: "main",
      message: "Add x",
      files: [{ path: "x.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scoutUser, repo, {
      title: "Add x",
      body: "",
      baseBranch: "main",
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "check passed" });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("answers well under the decider's own time, with no call made while rendering, and the second render carries the lean the first one asked for", async () => {
    const started = Date.now();
    const home = await (await get("/")).text();
    expect(Date.now() - started).toBeLessThan(DECIDER_MS / 2);
    expect(calls).toBe(0);
    expect(home).toContain("Ship");
    expect(home).not.toContain("by the decider");
    await pendingLeans();
    expect(calls).toBe(1);
    const again = await (await get("/")).text();
    expect(again).toContain("by the decider");
  });
});

/**
 * The studio head of an app that is not up: the same facts the App page
 * shows — why, the deploy that says the rest, and the way to try again.
 */
describe("the studio head says why the app is not up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let record: AppRecord;
  let runtime: AppsRuntime;
  let deploy: string;
  let writer: string;
  let reader: string;

  const head = (cookie: string) =>
    fetch(`${base}/alice/notes`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

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

  /**
   * An environment as the runtime holds it, without running a deploy: the
   * page reads `runtime.status(record)`, and a real failure would mean a
   * real install and a real health timeout for a rendering test.
   */
  interface Slot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    readonly live?: unknown;
    readonly lastError?: string;
    readonly lastRunId?: string;
  }
  const put = (
    slot: Omit<Slot, "app" | "env" | "chain" | "restarts">,
  ): void => {
    (runtime as unknown as { envs: Map<string, Slot> }).envs.set(
      `${record.id}/production`,
      {
        app: record,
        env: "production",
        chain: Promise.resolve(),
        restarts: [],
        ...slot,
      },
    );
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-notup-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, {
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    writer = await signIn("alice");
    reader = await signIn("bob");
    const made = await createRepo(app, a.value, {
      name: "notes",
      visibility: "public",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "notes\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: seeded.value.commitOid,
      reason: "push",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: "the deploy failed",
    });
    deploy = run.id;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a failed production says what failed, links its deploy, and offers Redeploy to a writer only", async () => {
    put({
      lastError: "the deploy failed: <install> exited 1",
      lastRunId: deploy,
    });
    const mine = await head(writer);
    expect(mine).toContain("not up");
    // The error is the app's own output: shown, and escaped.
    expect(mine).toContain("the deploy failed: &lt;install&gt; exited 1");
    expect(mine).not.toContain("<install>");
    expect(mine).toContain(`href="/alice/notes/runs/${deploy}"`);
    expect(mine).toContain('action="/alice/notes/app/production/redeploy"');
    expect(mine).toContain('action="/alice/notes/app/production/stop"');

    const theirs = await head(reader);
    expect(theirs).toContain("not up");
    expect(theirs).toContain("the deploy failed: &lt;install&gt; exited 1");
    expect(theirs).toContain(`href="/alice/notes/runs/${deploy}"`);
    expect(theirs).not.toContain("/app/production/redeploy");
    expect(theirs).not.toContain("/app/production/stop");
  });

  test("a stopped production says it is not running and offers Redeploy, not Stop", async () => {
    put({ lastRunId: deploy });
    const mine = await head(writer);
    expect(mine).toContain("not running");
    expect(mine).toContain('action="/alice/notes/app/production/redeploy"');
    expect(mine).not.toContain('action="/alice/notes/app/production/stop"');
  });

  test("a serving app with red tests still reads as serving, with the failure in its own words", async () => {
    put({
      live: {
        commitOid: "0".repeat(40),
        handle: { port: 4321 },
        runId: deploy,
        since: new Date(Date.now() - 60_000).toISOString(),
        testsFailed: "1 of 3 tests failed",
      },
    });
    const mine = await head(writer);
    expect(mine).toContain("serving · tests failed");
    expect(mine).not.toContain("not up");
    expect(mine).toContain("serving · tests failed: 1 of 3 tests failed");
  });
});
