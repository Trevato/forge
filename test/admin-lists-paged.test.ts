import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { mintInvite } from "../src/core/invites.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { offsetPage } from "../src/http/offset_page.ts";
import { proveAll } from "./helpers/verified.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("the admin's accounts, people and invites lists answer { items, next_cursor }", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let admin: string;

  const get = async (path: string) =>
    fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${admin}` } });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-admin-paged-"));
    app = createApp({ dataDir: dir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    const a = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: "owner-passphrase" });
    if (!a.ok) throw new Error("seed");
    for (const n of ["ada", "bea", "cy", "dee"]) {
      const made = await signUp(app, { username: n, email: `${n}@f.dev`, password: "guest-passphrase" }, { slot: fixtureSlot(app) });
      if (!made.ok) throw new Error("signup");
    }
    proveAll(app);
    admin = createToken(app.db, a.value.id, "t", "admin").token;
    for (let i = 0; i < 4; i++) mintInvite(app.db, a.value.id, 3);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  for (const path of ["/api/v1/admin/accounts", "/api/v1/admin/people", "/api/v1/admin/invites"]) {
    test(`${path}: the shape, paging to the end, a bad limit or cursor refused`, async () => {
      const whole = (await (await get(path)).json()) as { items: unknown[]; next_cursor: string | null };
      expect(Array.isArray(whole.items)).toBe(true);
      expect(whole.next_cursor).toBeNull();
      const total = whole.items.length;
      expect(total).toBeGreaterThanOrEqual(4);

      const seen: unknown[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(`${path}?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.status).toBe(200);
        const page = (await res.json()) as { items: unknown[]; next_cursor: string | null };
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items);
        cursor = page.next_cursor;
        pages++;
      } while (cursor !== null && pages < 50);
      expect(pages).toBe(Math.ceil(total / 2));
      expect(seen).toEqual(whole.items);

      for (const bad of ["0", "201", "-1", "x", "1.5", ""]) {
        const res = await get(`${path}?limit=${bad}`);
        expect(res.status).toBe(422);
        expect(await res.text()).toContain("invalid_limit");
      }
      expect((await get(`${path}?cursor=nope`)).status).toBe(422);
    });
  }

  test("offsetPage stops at the end", () => {
    expect(offsetPage([1, 2, 3], 3, 0)).toEqual({ items: [1, 2, 3], next_cursor: null });
    expect(offsetPage([1, 2, 3], 2, 0)).toEqual({ items: [1, 2], next_cursor: "2" });
    expect(offsetPage([1, 2, 3], 2, 2)).toEqual({ items: [3], next_cursor: null });
  });
});
