/**
 * The forge pill names the crew run working on the app (#2251): on
 * production any running agent run of the repository the viewer may see, on
 * a preview the one on its pull; gone when the run ends; nothing for someone
 * not signed in, and nothing about a sealed issue to who cannot see it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { crewNow } from "../src/apps/crew.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { setSealed } from "../src/core/sealed.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

describe("the crew line", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: string;
  let bob: string;
  let scout: string;
  let record: AppRecord;
  let repoId: string;
  let pullId: string;
  let pullNumber: number;
  let sealedId: string;
  const forge = "http://forge.test";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const person = async (username: string, adminIfFirst?: boolean) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        ...(adminIfFirst ? { adminIfFirst } : {}),
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await person("alice", true);
    alice = a.id;
    bob = (await person("bob")).id;
    scout = (await person("scout")).id;
    const made = await newApp(app, a, {
      name: "notes",
      description: "x",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.repo.id;
    record = getAppByRepo(app.db, repoId)!;
    const pull = createIssue(app.db, {
      repoId,
      authorId: alice,
      title: "p",
      kind: "pull",
    });
    if (!pull.ok) throw new Error(pull.error);
    pullId = pull.value.id;
    pullNumber = pull.value.number;
    const secret = createIssue(app.db, {
      repoId,
      authorId: alice,
      title: "s",
      kind: "issue",
    });
    if (!secret.ok) throw new Error(secret.error);
    sealedId = secret.value.id;
    setSealed(app.db, sealedId, true);
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const start = (issueId: string) => {
    const run = createRun(app.db, {
      repoId,
      kind: "agent",
      issueId,
      actorId: scout,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    return run;
  };
  const end = (id: string) => finishRun(app.db, id, { state: "ok", summary: "done" });
  const now = (env: string, ...viewer: [string?]) =>
    crewNow(app.db, forge, record, env, viewer.length ? viewer[0] : alice);

  test("idle shows nothing, a live run shows its agent and links its page, and ends", () => {
    expect(now("production")).toBeUndefined();
    const run = start(pullId);
    const seen = now("production")!;
    expect(seen.who).toBe("scout");
    expect(seen.url).toBe(`${forge}/alice/notes/runs/${run.id}`);
    end(run.id);
    expect(now("production")).toBeUndefined();
  });

  test("a preview shows only the run on its own pull, and it ends", () => {
    const run = start(pullId);
    expect(now(`pull-${pullNumber}`)!.who).toBe("scout");
    expect(now(`pull-${pullNumber + 1}`)).toBeUndefined();
    end(run.id);
    expect(now(`pull-${pullNumber}`)).toBeUndefined();
  });

  test("signed out, or an unknown person, shows nothing", () => {
    const run = start(pullId);
    expect(now("production", undefined)).toBeUndefined();
    expect(now("production", "nobody")).toBeUndefined();
    end(run.id);
  });

  test("a run on a sealed issue is named only to who may see that issue", () => {
    const run = start(sealedId);
    expect(now("production", bob)).toBeUndefined();
    expect(now("production", alice)!.who).toBe("scout");
    // Another run, on a visible pull, is still named to the one who cannot see the sealed one.
    const open = start(pullId);
    expect(now("production", bob)!.url).toContain(open.id);
    end(open.id);
    end(run.id);
  });

  test("/__forge/crew answers a granted viewer, and {} to no cookie or a bad one", async () => {
    const run = start(pullId);
    const target = { app: record, env: "production" } as AppTarget;
    const cookie = `forge_grant_${record.id.slice(-8)}`;
    const grant = signGrant(dataDir, target, 60_000, Date.now(), {
      id: alice,
      name: "alice",
      role: "admin",
    });
    const ask = (value?: string) =>
      fetch(`${servers.url}/__forge/crew`, {
        headers: {
          host: `notes.${DOMAIN}`,
          ...(value === undefined ? {} : { cookie: `${cookie}=${value}` }),
        },
      });
    const ok = await ask(grant);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await ok.json()).toEqual({
      who: "scout",
      url: `${servers.url}/alice/notes/runs/${run.id}`,
      tell: `${servers.url}/alice/notes/tell`,
    });
    expect(await (await ask()).json()).toEqual({});
    expect(await (await ask(`${grant}x`)).json()).toEqual({});
    // A grant that names nobody is a guest: nothing.
    const guest = signGrant(dataDir, target, 60_000);
    expect(await (await ask(guest)).json()).toEqual({});
    // A nested host is the guest forge's to answer, not this one's.
    const nested = await fetch(`${servers.url}/__forge/crew`, {
      headers: { host: `notes.other.${DOMAIN}`, cookie: `${cookie}=${grant}` },
    });
    expect(nested.headers.get("content-type") ?? "").not.toContain("json");
    expect(await nested.text()).not.toContain("scout");
    end(run.id);
  });

  test("the script asks once, same-origin, and never reads the page or its cookies", () => {
    expect(toolbarJs).toContain("/__forge/crew");
    // One fetch is the crew line; the other is `call`, the feedback door's
    // single path (#4758): the sender's notes, polled only while the panel
    // is open, the send, and (#4820) the picture when ticked, each carrying
    // the proof header in and out.
    expect(toolbarJs.match(/fetch\(/g)?.length).toBe(2);
    expect(toolbarJs.match(/setInterval/g)?.length).toBe(1);
    // The one place the page is read is `shoot`, which runs only when the
    // sender ticked the picture box; nothing else touches it.
    const from = toolbarJs.indexOf("function shoot()");
    const to = toolbarJs.indexOf('tellBox.addEventListener("submit"');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(toolbarJs.slice(0, from) + toolbarJs.slice(to)).not.toMatch(
      /document\.cookie|querySelector|getElementById|setTimeout/,
    );
    expect(toolbarJs).not.toContain("document.cookie");
    expect(toolbarJs).toContain('aria-live", "polite"');
    // The byte budget lives in test/toolbar-budget.test.ts.
  });
});
