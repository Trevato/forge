/** `/__forge/crew` hands a reader the app's other side, and nobody else (#6268). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let alice: string;
let bob: string;
let vault: AppRecord;
let preview: number;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-side-"));
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
  const user = async (username: string, adminIfFirst: boolean) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const a = await user("alice", true);
  alice = a.id;
  bob = (await user("bob", false)).id;
  const made = await newApp(app, a, { name: "vault", description: "x", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  vault = getAppByRepo(app.db, made.value.repo.id)!;
  const p = createIssue(app.db, { repoId: vault.repoId, authorId: alice, title: "secret plan", kind: "pull" });
  if (!p.ok) throw new Error(p.error);
  preview = p.value.number;
  const id = (
    app.db.query("SELECT id FROM issue WHERE repo_id = ? AND number = ?").get(vault.repoId, preview) as { id: string }
  ).id;
  app.db
    .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', 'x', 'b', 'h')")
    .run(id);
  (runtime as unknown as { envs: Map<string, unknown> }).envs.set(`${vault.id}/pull-${preview}`, {
    app: vault,
    env: `pull-${preview}`,
    chain: Promise.resolve(),
    restarts: [],
    dormant: { since: new Date().toISOString(), idleSince: new Date().toISOString(), commitOid: "h" },
  });
}, 120_000);

afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const crew = async (host: string, as?: { id: string; name: string }) => {
  const cookie =
    as === undefined
      ? undefined
      : `forge_grant_${vault.id.slice(-8)}=${signGrant(
          dataDir,
          { app: vault, env: host.includes("--") ? `pull-${preview}` : "production" } as AppTarget,
          60_000,
          Date.now(),
          { id: as.id, name: as.name, role: "admin" },
        )}`;
  const res = await fetch(`${servers.url}/__forge/crew`, {
    headers: { host, ...(cookie === undefined ? {} : { cookie }) },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, json: JSON.parse(text) as { side?: { label: string; url: string } } };
};

const prod = `vault.${DOMAIN}`;
const pre = () => `vault--${preview}.${DOMAIN}`;

test("production names the newest preview a reader may see", async () => {
  const { json } = await crew(prod, { id: alice, name: "alice" });
  expect(json.side).toEqual({
    label: `Newest preview: #${preview} secret plan`,
    url: runtime.urlFor(vault, `pull-${preview}`),
  });
});

test("a preview names production to a reader", async () => {
  const { json } = await crew(pre(), { id: alice, name: "alice" });
  expect(json.side).toEqual({ label: "Open on production", url: runtime.urlFor(vault, "production") });
});

test("a guest of a private app gets no side, and no pull title", async () => {
  for (const host of [prod, pre()]) {
    const { text, json } = await crew(host);
    expect(json.side).toBeUndefined();
    expect(text).not.toContain("secret plan");
  }
});

test("a signed-in stranger of a private app gets no side, and no pull title", async () => {
  for (const host of [prod, pre()]) {
    const { text, json } = await crew(host, { id: bob, name: "bob" });
    expect(json.side).toBeUndefined();
    expect(text).not.toContain("secret plan");
  }
});
