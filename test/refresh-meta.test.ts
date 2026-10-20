/**
 * No forge page carries a `meta refresh`. A refresh is set the moment the
 * parser meets the tag, and removing the tag afterwards does not cancel it
 * — which is how a live run page threw away the reader's scroll every five
 * seconds. Every page now follows the event stream instead (#3175, #3179),
 * and the layout no longer offers the option (#3195).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

const looks: string[] = (await Bun.file(new URL("../forge.json", import.meta.url)).json()).app.looks;

describe("no page refreshes itself", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-refresh-meta-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    cookie = await adminCookie(app, { username: "ada", email: "ada@f.dev", password: "refresh-password" });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("forge.json names pages to look at", () => {
    expect(looks.length).toBeGreaterThan(0);
  });

  for (const path of looks) {
    test(`${path}, signed in or not, has no http-equiv="refresh"`, async () => {
      for (const headers of [{ cookie }, {}]) {
        const res = await fetch(`${servers.url}${path}`, { headers, redirect: "manual" });
        const body = await res.text();
        expect(res.status).toBeLessThan(500);
        expect(body).not.toMatch(/http-equiv=["']?refresh/i);
      }
    });
  }

  test("the page's script no longer reaches for the tag it cannot cancel", async () => {
    const client = await Bun.file(
      new URL("../src/web/client.ts", import.meta.url),
    ).text();
    expect(client).not.toContain('meta[http-equiv="refresh"]');
  });

  test("a closed mirror stream reloads the page at most once per stream url", async () => {
    const { mirrorJs } = await import("../src/web/client.ts");
    const at = mirrorJs.indexOf("location.reload()");
    expect(at).toBeGreaterThan(-1);
    const before = mirrorJs.slice(0, at);
    // The guard is read and then set, both ahead of the one reload.
    expect(before).toContain("sessionStorage.getItem(url)");
    expect(before.indexOf("sessionStorage.getItem(url)")).toBeLessThan(
      before.indexOf("sessionStorage.setItem(url"),
    );
    expect(mirrorJs.match(/location\.reload\(\)/g)).toHaveLength(1);
  });
});
