/**
 * `/login` and `/sign-in` are the addresses people type: each answers 308 to
 * `/signin`, keeping `next` only when it is a path on this forge (#7721).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-signin-alias-"));
  app = createApp({ dataDir, port: 0, url: "https://forge.example" });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const go = (path: string) => fetch(`${servers.url}${path}`, { redirect: "manual" });

for (const alias of ["/login", "/sign-in"]) {
  describe(alias, () => {
    test("answers 308 to /signin", async () => {
      const res = await go(alias);
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("/signin");
    });

    test("keeps a same-origin next", async () => {
      const res = await go(`${alias}?next=/settings`);
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("/signin?next=%2Fsettings");
      const back = new URL(res.headers.get("location")!, servers.url);
      expect(back.searchParams.get("next")).toBe("/settings");
    });

    test("drops a next that leaves the forge", async () => {
      for (const next of ["//evil.test", "https://evil.test", "/\\evil.test"]) {
        const res = await go(`${alias}?next=${encodeURIComponent(next)}`);
        expect(res.status).toBe(308);
        expect(res.headers.get("location")).toBe("/signin");
      }
    });
  });
}

test("/signup is not an alias", async () => {
  const res = await go("/signup");
  expect(res.status).not.toBe(308);
});
