/**
 * An app page's `Link` header carries the app's own alternate manifest and
 * the forge's for its repository (#8288); only the forge's is titled, so an
 * agent can tell which describes what it may do with the app's repository.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { quietLogs } from "./helpers/globals.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { REPO_LINK_TITLE } from "../src/apps/proxy.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a public app's own alternate link and the forge's are told apart", () => {
  quietLogs();
  const DOMAIN = "apps.test";
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let backend: ReturnType<typeof Bun.serve>;
  let status: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/json") return Response.json({ a: 1 });
        return new Response("<html><body>hi</body></html>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            link: '</own.json>; rel="alternate"; type="application/json"',
          },
        });
      },
    });
    dataDir = await mkdtemp(join(tmpdir(), "forge-manifest-link-"));
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
      () =>
        ({
          env: "production",
          state: "running",
          port: backend.port,
          commitOid: "a".repeat(40),
        }) as EnvStatus,
    );
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
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
        description: "Words",
        visibility,
      });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 120_000);
  afterAll(async () => {
    status.mockRestore();
    await runtime.stop();
    servers.stop();
    backend.stop(true);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("both alternates survive and only the forge's is titled", async () => {
    const res = await fetch(`${servers.url}/`, {
      headers: { host: `notes.${DOMAIN}`, accept: "*/*" },
    });
    const link = res.headers.get("link") ?? "";
    expect(REPO_LINK_TITLE).toBe("this app's repository on its forge");
    expect(link).toContain('</own.json>; rel="alternate"; type="application/json"');
    expect(link).not.toContain('</own.json>; rel="alternate"; type="application/json"; title');
    expect(link).toContain(
      `<${servers.url}/api/v1/here?path=%2Falice%2Fnotes>; rel="alternate"; type="application/json"; title="${REPO_LINK_TITLE}"`,
    );
  });

  test("llms.txt names the title", async () => {
    const txt = await (await fetch(`${servers.url}/llms.txt`)).text();
    expect(txt).toContain(`"${REPO_LINK_TITLE}"`);
  });
});
