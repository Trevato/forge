/**
 * `/apps/open?host=` sends a signed grant to the host it names. That host
 * is read twice — once as an app label, once by a URL parser to build the
 * redirect — and the two readings must agree: `evil#x--notes.apps.test`
 * once passed the label check (no dot, last part a real slug) while the
 * parser called its host `evil`, and a valid grant left for a stranger's
 * origin. Now only a bare hostname, with at most a port, is a host at all.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp, updateAppSettings } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Repo } from "../src/core/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

describe("/apps/open sends a grant only to a host that reads one way", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  let aliceCookie = "";

  const signIn = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-open-redirect-"));
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
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    aliceCookie = await signIn("alice");

    const made = await newApp(app, alice, {
      name: "notes",
      description: "A place for notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = (host: string) => {
    const u = new URL(`${servers.url}/apps/open`);
    u.searchParams.set("host", host);
    u.searchParams.set("to", "/");
    return fetch(u, { headers: { cookie: aliceCookie }, redirect: "manual" });
  };

  test("a plain app host, with or without a port, is granted on itself", async () => {
    const plain = await open(`notes.${DOMAIN}`);
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get("location")!).hostname).toBe(
      `notes.${DOMAIN}`,
    );
    const ported = await open(`notes.${DOMAIN}:8443`);
    expect(ported.status).toBe(302);
    expect(new URL(ported.headers.get("location")!).host).toBe(
      `notes.${DOMAIN}:8443`,
    );
  });

  test("a host a URL parser would read as another machine is not a host", async () => {
    for (const crafted of [
      `evil#stuff--notes.${DOMAIN}`,
      `2130706433@notes--${DOMAIN}`,
      `evil.example/@notes.${DOMAIN}`,
      `notes.${DOMAIN}/x`,
      `notes.${DOMAIN}?x`,
      `notes.${DOMAIN}:80:80`,
      `-notes.${DOMAIN}`,
    ]) {
      const res = await open(crafted);
      expect([crafted, res.status]).toEqual([crafted, 404]);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("the proxy reads such a Host the same way: not ours", async () => {
    const res = await fetch(`${servers.url}/`, {
      headers: { host: `evil#stuff--notes.${DOMAIN}` },
      redirect: "manual",
    });
    // The forge answers for itself, as for any hostname it does not know.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>");
  });
});
