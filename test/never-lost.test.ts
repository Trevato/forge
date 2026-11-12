/**
 * The Lost test (P6 Never lost): from production and from a preview, the
 * pill says where you are and links home, to comment, and to tell the crew.
 * One forge, one app serving one HTML page, asked through the app proxy as
 * production and as the preview of an open pull, signed in and signed out.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { TOOLBAR_ASSET_PATH } from "../src/apps/toolbar.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const HTML = "<html><body><h1>hi</h1></body></html>";

describe("never lost: the pill from production and from a preview", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let backend: ReturnType<typeof Bun.serve>;
  let status: ReturnType<typeof spyOn>;
  let record: AppRecord;
  let pull: number;
  let auth: Record<string, string>;
  let alice: string;

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      fetch: () => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    dataDir = await mkdtemp(join(tmpdir(), "forge-never-lost-"));
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
    status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      (_app: unknown, env: string) =>
        ({
          env,
          state: "running",
          port: backend.port,
          commitOid: "a".repeat(40),
        }) as EnvStatus,
    );
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    alice = u.value.id;
    const made = await newApp(app, u.value, { name: "notes", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    record = getAppByRepo(app.db, made.value.repo.id)!;
    const p = createIssue(app.db, { repoId: record.repoId, authorId: alice, title: "a change", kind: "pull" });
    if (!p.ok) throw new Error(p.error);
    pull = p.value.number;
    auth = { authorization: `Bearer ${createToken(app.db, alice, "t", "rw").token}` };
  }, 120_000);

  afterAll(async () => {
    status.mockRestore();
    await runtime.stop();
    servers.stop();
    backend.stop(true);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const cookieFor = (env: string) =>
    `forge_grant_${record.id.slice(-8)}=${signGrant(dataDir, { app: record, env } as AppTarget, 60_000, Date.now(), {
      id: alice,
      name: "alice",
      role: "admin",
    })}`;
  const ask = (host: string, path: string, cookie?: string) =>
    fetch(`${servers.url}${path}`, {
      headers: { host, accept: "text/html", ...(cookie === undefined ? {} : { cookie }) },
      redirect: "manual",
    });

  const places = [
    { name: "production", preview: false },
    { name: "a preview", preview: true },
  ];

  for (const place of places) {
    describe(place.name, () => {
      const host = () => (place.preview ? `notes--${pull}.${DOMAIN}` : `notes.${DOMAIN}`);
      const env = () => (place.preview ? `pull-${pull}` : "production");

      test("signed in: the page says where you are; the pill's links all answer", async () => {
        const res = await ask(host(), "/", cookieFor(env()));
        expect(res.status).toBe(200);
        const html = await res.text();
        const tag = /<script src="([^"]+)"([^>]*) defer><\/script>/.exec(html);
        expect(tag).not.toBeNull();
        expect(tag![1]).toBe(TOOLBAR_ASSET_PATH);
        expect(tag![2]).toContain(' data-app="notes"');
        expect(tag![2]).toContain(' data-repo="alice/notes"');
        expect(tag![2]).toContain(` data-env="${env()}"`);
        if (place.preview) expect(tag![2]).toContain(` data-pull="${pull}"`);
        else expect(tag![2]).not.toContain("data-pull");

        // The crew door answers the owner with the forge's own tell page.
        const crew = await ask(host(), "/__forge/crew", cookieFor(env()));
        expect(crew.status).toBe(200);
        const tell = ((await crew.json()) as { tell?: string }).tell;
        expect(tell).toBe(`${servers.url}/alice/notes/tell`);

        // Home, comment/tell/make-it-yours, and the tell form: forge origin, 200.
        const query = new URLSearchParams({ env: env(), page: `http://${host()}/` });
        const links = [
          `${servers.url}/`,
          `${servers.url}/alice/notes/toolbar?${query}`,
          `${tell}?${new URLSearchParams({ page: `http://${host()}/`, ...(place.preview ? { pull: String(pull) } : {}) })}`,
        ];
        for (const link of links) {
          expect(new URL(link).origin).toBe(servers.url);
          const got = await fetch(link, { headers: auth, redirect: "manual" });
          expect(got.status).toBe(200);
        }
        const form = await (await fetch(links[2]!, { headers: auth })).text();
        expect(form).toContain("<form");
      });

      test("signed out: still says where you are, offers sign-in in place of tell", async () => {
        const html = await (await ask(host(), "/")).text();
        expect(html).toContain(' data-app="notes"');
        expect(html).toContain(` data-env="${env()}"`);
        if (place.preview) expect(html).toContain(` data-pull="${pull}"`);
        // A public app offers a stranger Make it yours, never the tell page.
        expect(await (await ask(host(), "/__forge/crew")).json()).toEqual({
          yours: `${servers.url}/alice/notes/make-it-yours`,
        });
        const door = await (await ask(host(), "/__forge/")).text();
        expect(door).toContain("/__forge/signin");
        expect(door).not.toContain("/alice/notes/tell");
      });
    });
  }
});
