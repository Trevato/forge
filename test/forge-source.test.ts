/**
 * The forge's own source (`settings/forge_source.ts`): an admin names the
 * repository the forge is built from, and that repository's app — a test
 * copy every pull previews from — is shown with the forge itself as its
 * production. Display only: the forge's hostname is still no app's domain,
 * requests to it still reach the forge, and every other repository is shown
 * its app's own address.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAppDomain } from "../src/actions/domains.ts";
import { createRepo } from "../src/actions/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { isForgeSource } from "../src/core/forge_repo.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeSource } from "../src/settings/forge_source.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const words = (html: string): string => html.replace(/\s+/g, " ");

describe("the forge's own source", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let own: Repo;
  let other: Repo;
  let token: string;

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      redirect: "manual",
    });
  const page = (path: string) =>
    fetch(`${servers.url}${path}`, { redirect: "manual" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-source-"));
    app = createApp({
      dataDir,
      port: 0,
      host: "forge.test",
      url: "https://forge.test",
    });
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
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    token = createToken(app.db, alice.id, "t", "admin").token;
    for (const name of ["forge", "notes"]) {
      const made = await createRepo(app, alice, {
        name,
        visibility: "public",
        description: "",
      });
      if (!made.ok) throw new Error(made.error);
      const row = insertApp(app.db, {
        repoId: made.value.id,
        slug: name === "forge" ? "lab" : "notes",
        access: "public",
      });
      if (!row.ok) throw new Error(row.error);
      if (name === "forge") own = made.value;
      else other = made.value;
    }
  });

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("unset, nothing is the forge's source and every app shows its own address", async () => {
    expect(forgeSource(app.db, app.config.forgeRepo)).toBeUndefined();
    const body = words(await (await page("/alice/forge")).text());
    expect(body).toContain(`lab.${DOMAIN}`);
    expect(body).not.toContain("Test copy");
    const open = await page("/alice/forge/app/production/open");
    expect(open.headers.get("location") ?? "").not.toBe("https://forge.test");
  });

  test("an admin sets it through the API; a bad name is refused", async () => {
    expect(
      (
        await api("/api/v1/admin/settings", {
          method: "PATCH",
          body: JSON.stringify({ forgeRepo: "no slash" }),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api("/api/v1/admin/settings", {
          method: "PATCH",
          body: JSON.stringify({ forgeRepo: "alice/forge", signup: "open" }),
        })
      ).status,
    ).toBe(422);
    const set = await api("/api/v1/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ forgeRepo: "alice/forge" }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ forgeRepo: "alice/forge" });
    const read = (await (await api("/api/v1/admin/settings")).json()) as {
      forgeRepo: string;
      forgeRepoInForce: string;
    };
    expect(read.forgeRepo).toBe("alice/forge");
    expect(read.forgeRepoInForce).toBe("alice/forge");
    expect(isForgeSource(app, own)).toBe(true);
    expect(isForgeSource(app, other)).toBe(false);
  });

  test("its page shows the forge as production and the app as a test copy; production opens the forge", async () => {
    const body = words(await (await page("/alice/forge")).text());
    expect(body).toContain(`href="/alice/forge/app/production/open" class="mono" >forge.test</a`);
    expect(body).toContain("Test copy:");
    expect(body).toContain(`/apps/open?host=lab.${DOMAIN}`);
    const open = await page("/alice/forge/app/production/open");
    expect(open.status).toBe(302);
    expect(open.headers.get("location")).toBe("https://forge.test");
    // A pull's preview still opens where it runs, not the forge.
    const preview = await page("/alice/forge/app/pull-1/open");
    expect(preview.headers.get("location") ?? "").not.toBe(
      "https://forge.test",
    );
  });

  test("another repository is unchanged", async () => {
    const body = words(await (await page("/alice/notes")).text());
    expect(body).toContain(`notes.${DOMAIN}`);
    expect(body).not.toContain("Test copy");
    const open = await page("/alice/notes/app/production/open");
    expect(open.headers.get("location") ?? "").toContain(`notes.${DOMAIN}`);
  });

  test("the forge's hostname is still no app's domain, its own source's included", () => {
    for (const repo of [own, other]) {
      const refused = addAppDomain(app, alice, repo, "forge.test");
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toBe("reserved_host");
    }
  });

  test("requests to the forge's hostname still reach the forge", async () => {
    const r = await fetch(`${servers.url}/alice/forge`, {
      headers: { host: "forge.test" },
      redirect: "manual",
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Test copy:");
  });

  test("cleared, the page is as it was", async () => {
    expect(
      (
        await api("/api/v1/admin/settings", {
          method: "PATCH",
          body: JSON.stringify({ forgeRepo: null }),
        })
      ).status,
    ).toBe(200);
    expect(isForgeSource(app, own)).toBe(false);
    expect(words(await (await page("/alice/forge")).text())).not.toContain(
      "Test copy",
    );
  });
});
