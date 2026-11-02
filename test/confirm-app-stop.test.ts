/**
 * Stopping production or a preview asks first (#7977): the head card's Stop
 * is a link to the confirm page, the confirm page knows the route and words
 * it, and its own Stop lands the person on the app, not back on the
 * question they just answered.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { withScripts } from "./helpers/page-script.ts";

const PASSWORD = "a-good-passphrase";
const TO = "/alice/notes/app/production/stop";
const CONFIRM = `/-/confirm?to=${encodeURIComponent(TO)}`;

describe("Stop on an app's environment goes through the confirm page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let runtime: AppsRuntime;
  let alice: string;
  let bob: string;

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: PASSWORD }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  const person = async (username: string, admin = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: PASSWORD,
      adminIfFirst: admin,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };

  /** Production serving, as the runtime holds it, with no real deploy. */
  const putLive = (): void => {
    const record = getAppByRepo(app.db, repo.id)!;
    (
      runtime as unknown as { envs: Map<string, Record<string, unknown>> }
    ).envs.set(`${record.id}/production`, {
      app: record,
      env: "production",
      chain: Promise.resolve(),
      restarts: [],
      live: {
        commitOid: "a".repeat(40),
        handle: { port: 4321, stop: async () => {} },
        runId: "fake",
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
  };

  const get = (cookie: string, path: string): Promise<Response> =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-confirm-app-stop-"));
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
    const a = await person("alice", true);
    await person("bob");
    alice = await signIn("alice");
    bob = await signIn("bob");
    const made = await createRepo(app, a, {
      name: "notes",
      visibility: "public",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "notes\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
  });

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the app page's Stop is a link to the confirm page; Redeploy stays a form", async () => {
    putLive();
    const html = await (await get(alice, "/alice/notes")).text();
    expect(html).toContain(`href="${CONFIRM}"`);
    expect(html).not.toContain(`action="${TO}"`);
    expect(html).toContain('action="/alice/notes/app/production/redeploy"');
  });

  test("the confirm page words a Stop of production for a writer, and knows no made-up env", async () => {
    const page = await get(alice, CONFIRM);
    expect(page.status).toBe(200);
    const html = (await page.text()).replace(/\s+/g, " ");
    expect(html).toContain("Stop production of alice/notes?");
    expect(html).toContain(
      "It stops answering at its address until someone presses Redeploy. Its data stays where it is.",
    );
    expect(html).toContain(`action="${TO}"`);
    const preview = await get(
      alice,
      `/-/confirm?to=${encodeURIComponent("/alice/notes/app/pull-3/stop")}`,
    );
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("Stop pull-3 of alice/notes?");
    const bogus = await get(
      alice,
      `/-/confirm?to=${encodeURIComponent("/alice/notes/app/evil/stop")}`,
    );
    expect(bogus.status).toBe(404);
  });

  test("Stop from the confirm page lands on the app, not back on /-/confirm", async () => {
    putLive();
    const stopped = await fetch(`${base}${TO}`, {
      method: "POST",
      headers: {
        cookie: `${alice}; forge_mode=studio`,
        origin: base,
        referer: `${base}${CONFIRM}`,
      },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/alice/notes");
  });

  test("a reader is never offered Stop", async () => {
    putLive();
    const html = await (await get(bob, "/alice/notes")).text();
    expect(await withScripts(base, html)).toContain("serving");
    expect(html).not.toContain(encodeURIComponent(TO));
  });
});
