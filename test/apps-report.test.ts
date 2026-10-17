/**
 * Every public app tells a visitor how to report a problem (#701): the
 * forge answers `/__forge/report` on the app's own host — without waking
 * the app, which may be the thing that is broken — and sends the visitor to
 * the repository's report form with the page they came from. Its pages,
 * and the forge's own "not running" page, carry a `Link` to it. A private
 * app offers none of it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

describe("a public app links to Report a problem", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-report-"));
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    for (const [name, visibility] of [
      ["notes", "public"],
      ["diary", "private"],
    ] as const) {
      const made = await newApp(app, a.value, {
        name,
        description: "A place for words",
        visibility,
      });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const at = (slug: string, path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        host: `${slug}.${DOMAIN}`,
        accept: "text/html",
        ...(init.headers as Record<string, string>),
      },
      redirect: "manual",
    });

  test("/__forge/report sends a visitor to the repository's form, with the page", async () => {
    const res = await at("notes", "/__forge/report?from=/leaderboard");
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(
      `${servers.url}/alice/notes/report`,
    );
    expect(to.searchParams.get("from")).toBe(
      `http://notes.${DOMAIN}:${servers.port}/leaderboard`,
    );
    // Only a path of this app is ever named as the page.
    const away = await at("notes", "/__forge/report?from=//evil.example/x");
    expect(new URL(away.headers.get("location")!).searchParams.get("from")).toBe(
      `http://notes.${DOMAIN}:${servers.port}/`,
    );
    // And the form it lands on is the one anybody may fill.
    const form = await fetch(to);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="title"');
  });

  test("a public app's page carries the link relation, running or not", async () => {
    const page = await at("notes", "/");
    expect(page.headers.get("link") ?? "").toContain(
      '</__forge/report>; rel="help"',
    );
    const body = await page.text();
    expect(body).toContain('href="/__forge/report"');
  });

  test("a private app offers no report path", async () => {
    const res = await at("diary", "/__forge/report");
    expect(res.headers.get("location") ?? "").not.toContain("/report");
    const page = await at("diary", "/");
    expect(page.headers.get("link") ?? "").not.toContain("__forge/report");
  });
});
