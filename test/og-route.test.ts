import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("og cards", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-og-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const u = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    for (const [name, visibility, slug] of [
      ["shown", "public", "shown-app"],
      ["hidden", "private", "hidden-app"],
    ] as const) {
      const made = await createRepo(app, u.value, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const rec = createApp(app.db, {
        repoId: made.value.id,
        slug,
        access: "public",
      });
      if (!rec.ok) throw new Error(rec.error);
    }
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { headers });

  for (const [kind, good, private_] of [
    ["repo", "alice~shown", "alice~hidden"],
    ["app", "shown-app", "hidden-app"],
  ] as const) {
    describe(kind, () => {
      test("200 with the card, cache and security headers", async () => {
        const res = await get(`/og/${kind}/${good}.svg`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("image/svg+xml");
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBeTruthy();
        expect(res.headers.get("content-security-policy")).toContain(
          "default-src 'none'",
        );
        expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
        expect(await res.text()).toStartWith("<svg");
      });

      test("304 on If-None-Match", async () => {
        const first = await get(`/og/${kind}/${good}.svg`);
        const etag = first.headers.get("etag")!;
        const again = await get(`/og/${kind}/${good}.svg`, {
          "if-none-match": etag,
        });
        expect(again.status).toBe(304);
        expect(await again.text()).toBe("");
        const other = await get(`/og/${kind}/${good}.svg`, {
          "if-none-match": '"nope"',
        });
        expect(other.status).toBe(200);
      });

      test("a private repo is 404", async () => {
        expect((await get(`/og/${kind}/${private_}.svg`)).status).toBe(404);
      });

      test("an unknown or malformed ref is 404", async () => {
        for (const ref of ["nobody~nothing", "nothing", "a~b~c", "..%2Fx", "A_B"])
          expect((await get(`/og/${kind}/${ref}.svg`)).status).toBe(404);
      });
    });
  }
});
