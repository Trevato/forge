/**
 * An app's credential into the forge (issue #388): every app and preview
 * process starts with `FORGE_API_URL` and a read-only token of its owner's,
 * minted at the start, renewed while it runs, revoked when it stops; the
 * token reads `/events`; and the sample page in `examples/forge-live`,
 * deployed as an app, lists `now` live and offers `say`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { appEnv } from "../src/apps/process.ts";
import { held, type AppTarget } from "../src/apps/proxy.ts";
import {
  APP_TOKEN_TTL_MS,
  appTokenName,
  forgeApiUrl,
  mintAppToken,
  renewAppToken,
  revokeAppToken,
} from "../src/apps/token.ts";
import { bakedFiles as scaffoldFiles } from "../src/apps/template.ts";
import { newApp } from "../src/actions/apps.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, listRuns, type Run } from "../src/core/runs.ts";
import {
  createToken,
  listTokens,
  renewToken,
  verifyToken,
  type TokenInfo,
} from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const EXAMPLE = join(import.meta.dir, "..", "examples", "forge-live");

async function user(app: App, username: string): Promise<User> {
  const made = await createUser(app.db, { origin: "seed", trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

/** Read an event stream until `seen` says yes, or fail after `ms`. */
async function readUntil(
  response: Response,
  seen: (text: string) => boolean,
  ms = 10_000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => undefined),
      ]);
      if (next === undefined || next.done) break;
      text += decoder.decode(next.value, { stream: true });
      if (seen(text)) return text;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`stream did not say it in time; heard:\n${text}`);
}

describe("app tokens: the record", () => {
  let dataDir: string;
  let app: App;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apptoken-unit-"));
    app = createApp({ dataDir, port: 0 });
    alice = await user(app, "alice");
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("minted read-only, the owner's, named for the app, expiring a day out", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    const minted = mintAppToken(app.db, alice.id, "notes", "pull-3", now);
    const info = listTokens(app.db, alice.id).find((t) => t.id === minted.id)!;
    expect(info.name).toBe(appTokenName("notes", "pull-3"));
    expect(info.name).toBe("app:notes/pull-3");
    expect(info.scope).toBe("ro");
    expect(Date.parse(info.expiresAt!)).toBe(now + APP_TOKEN_TTL_MS);
    // The expiry is the real clock's here, so the token works now.
    const fresh = mintAppToken(app.db, alice.id, "notes", "production");
    const verified = verifyToken(app.db, fresh.token);
    expect(verified.ok && verified.value.scope).toBe("ro");
    expect(verified.ok && verified.value.user.id).toBe(alice.id);
  });

  test("renewing slides the expiry; revoking ends it; a token with no expiry is never given one", () => {
    const minted = mintAppToken(app.db, alice.id, "notes", "production", 0);
    // Minted at the epoch: already expired, refused.
    expect(verifyToken(app.db, minted.token).ok).toBe(false);
    renewAppToken(app.db, minted.id);
    expect(verifyToken(app.db, minted.token).ok).toBe(true);
    revokeAppToken(app.db, minted.id);
    expect(verifyToken(app.db, minted.token).ok).toBe(false);
    revokeAppToken(app.db, undefined); // nothing to revoke is not an error

    const personal = createToken(app.db, alice.id, "laptop", "rw");
    expect(renewToken(app.db, personal.id, new Date().toISOString())).toBe(
      false,
    );
    const info = listTokens(app.db, alice.id).find(
      (t) => t.id === personal.id,
    )!;
    expect(info.expiresAt).toBeNull();
  });

  test("the process is told the API's URL and its token; no token, no variable", () => {
    const base = {
      port: 4100,
      dataDir: "/data/x",
      env: "production" as const,
      url: "http://notes.apps.test",
      commitOid: "a".repeat(40),
      forgeUrl: "https://forge.test/",
      identityKey: "k",
    };
    const told = appEnv({ ...base, forgeToken: "forge_secret" });
    expect(told["FORGE_API_URL"]).toBe("https://forge.test/api/v1");
    expect(told["FORGE_TOKEN"]).toBe("forge_secret");
    expect(forgeApiUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/api/v1",
    );
    const untold = appEnv(base);
    expect(untold["FORGE_TOKEN"]).toBeUndefined();
    expect(untold["FORGE_API_URL"]).toBe("https://forge.test/api/v1");
    // An operator's variable cannot stand in for the forge's own.
    const shadowed = appEnv({
      ...base,
      forgeToken: "forge_real",
      vars: { FORGE_TOKEN: "forge_fake", FORGE_API_URL: "https://evil" },
    });
    expect(shadowed["FORGE_TOKEN"]).toBe("forge_real");
    expect(shadowed["FORGE_API_URL"]).toBe("https://forge.test/api/v1");
  });
});

describe("a proxied event stream whose app goes away", () => {
  test("ends, released, rather than erroring into the browser's connection", async () => {
    let released = 0;
    const runtime = {
      holdStream: () => () => void released++,
    } as unknown as AppsRuntime;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("ECONNRESET"));
      },
    });
    const reader = held(runtime, {} as AppTarget, upstream).getReader();
    expect((await reader.read()).done).toBe(true);
    expect(released).toBe(1);
  });
});

describe("app tokens: live, end to end", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let record: AppRecord;
  let skew = 0;
  const DOMAIN = "apps.test";
  const HOST = `live.${DOMAIN}`;

  const viaHost = (path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), host: HOST },
      redirect: "manual",
    });

  async function settled(where: (run: Run) => boolean): Promise<Run> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        (r) => where(r) && (r.state === "ok" || r.state === "failed"),
      );
      if (run) return run;
      await Bun.sleep(10); // real-timer: polls a deploy worker running in the background
    }
    throw new Error("run did not settle in time");
  }

  const appTokens = (env: string): TokenInfo[] =>
    listTokens(app.db, alice.id).filter(
      (t) => t.name === appTokenName("live", env),
    );

  /** The sample page's files, as the commit that makes this app it. */
  const exampleFiles = (stamp: string) =>
    readdirSync(EXAMPLE).map((name) => ({
      path: name,
      content:
        name === "README.md"
          ? `${readFileSync(join(EXAMPLE, name), "utf8")}\n<!-- ${stamp} -->\n`
          : readFileSync(join(EXAMPLE, name), "utf8"),
    }));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apptoken-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      sweepEveryMs: 20,
      clock: () => Date.now() + skew,
    });
    await runtime.start();
    alice = await user(app, "alice");
    bob = await user(app, "bob");
    const made = await newApp(app, alice, {
      name: "live",
      description: "Now, live",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
    await settled((r) => r.env === "production");
    // Make it the sample page: the scaffold out, the example in.
    const scaffold = scaffoldFiles({ name: "live", description: "Now, live" });
    const ours = new Set(readdirSync(EXAMPLE));
    const committed = await commitToBranch(app, alice, repo, {
      message: "The forge, live",
      files: [
        ...scaffold
          .filter((f) => !ours.has(f.path))
          .map((f) => ({ path: f.path, content: null })),
        ...exampleFiles("first"),
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const run = await settled(
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    expect(run.state).toBe("ok");
  }, 180_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a running environment holds exactly one token: its owner's, read-only, expiring", () => {
    const held = appTokens("production");
    expect(held).toHaveLength(1);
    expect(held[0]!.scope).toBe("ro");
    expect(held[0]!.expiresAt).not.toBeNull();
    // The previous deploy's process is gone, and its token with it.
    expect(
      listTokens(app.db, alice.id).filter((t) => t.name.startsWith("app:")),
    ).toHaveLength(1);
  });

  test("/events streams with a Bearer token, and only what its holder may read", async () => {
    const secret = await createRepo(app, alice, {
      name: "secret",
      visibility: "private",
    });
    if (!secret.ok) throw new Error(String(secret.error));
    const aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    const bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    const listen = (token: string) =>
      fetch(`${servers.url}/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const [hers, his] = await Promise.all([listen(aliceRo), listen(bobRo)]);
    expect(hers.status).toBe(200);
    expect(hers.headers.get("content-type")).toContain("text/event-stream");
    // The private issue first, then a public one both may read: events
    // arrive in order, so by the time bob hears the public one he would
    // have heard the private one. No waiting for silence.
    expect(openIssue(app, alice, secret.value, { title: "the private plan" }).ok).toBe(true);
    expect(openIssue(app, alice, repo, { title: "the public plan" }).ok).toBe(true);
    const heard = await readUntil(hers, (t) => t.includes("alice/secret"));
    expect(heard).toContain("event: forge");
    const bobHeard = await readUntil(his, (t) => t.includes("alice/live"));
    expect(bobHeard).not.toContain("alice/secret");
  });

  test("acceptance: the sample page lists `now`, offers `say`, and goes live on /events", async () => {
    const issue = openIssue(app, alice, repo, { title: "Make it <b>bold</b>" });
    if (!issue.ok) throw new Error(String(issue.error));
    createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.value.id,
      actorId: bob.id,
      reason: "assigned",
    });

    const page = await viaHost("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const html = await page.text();
    expect(html).toContain('<ul id="now">');
    expect(html).toContain(
      `#${issue.value.number} Make it &lt;b&gt;bold&lt;/b&gt;`,
    );
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain('<span class="who">bob</span>');
    // `say` goes to the forge, where the person speaks as themselves.
    expect(html).toContain(
      `<a class="say" href="${servers.url}/alice/live/issues/${issue.value.number}#say">say</a>`,
    );
    // The token never reaches the browser.
    const held = appTokens("production")[0]!;
    expect(html).not.toContain("forge_");
    expect(held).toBeDefined();

    // Live: the page's stream says "changed" when the forge says anything.
    const stream = await viaHost("/live", {
      headers: { accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    const said = readUntil(stream, (t) => t.includes("event: changed"));
    // The relay opens its upstream a moment after it answers: say
    // something until it hears.
    const poke = setInterval(
      () => openIssue(app, alice, repo, { title: "Another thing" }),
      15,
    );
    try {
      expect(await said).toContain("data: {}");
    } finally {
      clearInterval(poke);
    }
    // And the fragment the page refetches lists the same runs.
    expect(await (await viaHost("/now")).text()).toContain("bob");
  }, 30_000);

  test("the sweep renews a running environment's token", async () => {
    const before = appTokens("production")[0]!;
    skew += 60_000; // the sweep's clock moves a minute; no waiting for it
    let after = appTokens("production")[0]!;
    for (let i = 0; i < 500 && after.expiresAt === before.expiresAt; i++) {
      await Bun.sleep(5); // real-timer: the sweep runs on its own 20 ms interval; its clock is already faked
      after = appTokens("production")[0]!;
    }
    expect(after.id).toBe(before.id);
    expect(Date.parse(after.expiresAt!)).toBeGreaterThan(
      Date.parse(before.expiresAt!),
    );
  });

  test("a redeploy rotates the token; stopping the environment deletes it", async () => {
    const before = appTokens("production")[0]!;
    // A page left open across the deploy: its stream through the proxy
    // ends cleanly when the old process goes, for EventSource to reconnect.
    const open = await viaHost("/live", {
      headers: { accept: "text/event-stream" },
    });
    const ended = (async () => {
      const reader = open.body!.getReader();
      for (;;) if ((await reader.read()).done) return "ended";
    })();
    const committed = await commitToBranch(app, alice, repo, {
      message: "Again",
      files: exampleFiles("second"),
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const run = await settled(
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    expect(run.state).toBe("ok");
    expect(await ended).toBe("ended");
    const after = appTokens("production");
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before.id);
    // The new process still reads the forge with it.
    expect(await (await viaHost("/now")).text()).toContain("bob");

    await runtime.stopEnv(record, "production");
    expect(appTokens("production")).toHaveLength(0);
  }, 120_000);
});
