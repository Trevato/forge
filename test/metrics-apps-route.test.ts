/** `GET /metrics` from a real forge: a seeded running app is up, a sleeping one is 0, a private app is named by id only (#3752). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp as createAppRecord, type AppRecord } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { appSources } from "../src/metrics/app_sources.ts";
import { forgeMetrics } from "../src/metrics/forge.ts";

let dir: string;
let app: App;
let servers: Servers;
let ro: string;
let open: AppRecord;
let secret: AppRecord;
let runtime: AppsRuntime;

const record = (r: { ok: boolean; value?: AppRecord; error?: string }): AppRecord => {
  if (!r.ok) throw new Error(String(r.error));
  return r.value!;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "metrics-apps-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  ro = createToken(app.db, made.value.id, "t", "ro").token;
  const repos = [];
  for (const name of ["notes", "plans"]) {
    const r = await createRepo(app, made.value, { name });
    if (!r.ok) throw new Error(String(r.error));
    repos.push(r.value);
  }
  open = record(createAppRecord(app.db, { repoId: repos[0]!.id, slug: "notes", access: "public" }));
  secret = record(createAppRecord(app.db, { repoId: repos[1]!.id, slug: "secret-plans", access: "private" }));
  // An unstarted runtime holding what a started one would: no cell is spawned.
  runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
  const envs = (runtime as unknown as { envs: Map<string, unknown> }).envs;
  const live = {
    commitOid: "abc",
    handle: { port: 1 },
    runId: "r1",
    since: "2026-01-01T00:00:00Z",
    servingAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    manifest: {},
    deployStartedAt: null,
  };
  const base = { openStreams: 0, openRequests: 0, chain: Promise.resolve(), restarts: [] };
  envs.set("a", { ...base, app: open, env: "production", live });
  envs.set("b", { ...base, app: secret, env: "production", live });
  envs.set("c", { ...base, app: open, env: "pull-7", asleep: { commitOid: "abc", runId: "r2", since: "2026-01-01T00:00:00Z" } });
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("appSources marks the private app private", () => {
  const bySlug = new Map(appSources(app).apps.map((a) => [a.slug, a]));
  expect(bySlug.get("notes")?.private).toBe(false);
  expect(bySlug.get("secret-plans")?.private).toBe(true);
});

test("the body names a private app by id and never by slug", () => {
  const body = forgeMetrics(app.db, appSources(app));
  expect(body).toContain(`forge_app_up{app="${secret.id}",env="production"} 1`);
  expect(body).not.toContain("secret-plans");
});

test("GET /metrics with an admin ro token carries forge_app_up for the seeded apps", async () => {
  const res = await fetch(`${servers.url}/metrics`, { headers: { authorization: `Bearer ${ro}` } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain('forge_app_up{app="notes",env="production"} 1');
  expect(body).toContain('forge_app_up{app="notes",env="pull-7"} 0');
  expect(body).toContain(`forge_app_up{app="${secret.id}",env="production"} 1`);
  expect(body).not.toContain("secret-plans");
});
