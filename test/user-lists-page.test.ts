/** The caller's SSH keys, pins and orgs answer `{ items, next_cursor }` with a bounded limit and a cursor. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg } from "../src/actions/orgs.ts";
import { pinRepo } from "../src/actions/origins.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addSshKey, deleteSshKey } from "../src/actions/users.ts";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

type Page = { items: Record<string, unknown>[]; next_cursor: string | null };

/** A well-formed ed25519 line with random key bytes: no ssh-keygen needed. */
function ed25519Line(comment: string): string {
  const field = (b: Uint8Array) => {
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length);
    out.set(b, 4);
    return out;
  };
  const algo = field(new TextEncoder().encode("ssh-ed25519"));
  const pub = field(crypto.getRandomValues(new Uint8Array(32)));
  const blob = new Uint8Array(algo.length + pub.length);
  blob.set(algo);
  blob.set(pub, algo.length);
  return `ssh-ed25519 ${Buffer.from(blob).toString("base64")} ${comment}`;
}

describe("the caller's lists are pages", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let token = "";
  let aliceUser: Parameters<typeof deleteSshKey>[1];

  const get = (path: string) =>
    fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

  /** Every page to the end with `limit=2`; the pages' sizes and all names. */
  async function walk(path: string, name: string) {
    const sizes: number[] = [];
    const names: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q: string = `limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const page = (await (await get(`${path}?${q}`)).json()) as Page;
      sizes.push(page.items.length);
      names.push(...page.items.map((x) => x[name]));
      cursor = page.next_cursor;
      if (cursor === null) break;
    }
    return { sizes, names };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-user-lists-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const a = await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("seed failed");
    const alice = a.value;
    aliceUser = alice;
    proveAll(app);
    for (const org of ["org-a", "org-b", "org-c"]) createOrg(app, alice, org);
    for (const name of ["r1", "r2", "r3"]) {
      const made = await createRepo(app, alice, { name, visibility: "private" });
      if (!made.ok) throw new Error(`repo failed: ${made.error}`);
      pinRepo(app, alice, made.value);
    }
    {
      for (const n of ["k1", "k2", "k3"]) {
        const added = addSshKey(app, alice, { name: n, key: ed25519Line(n) });
        if (!added.ok) throw new Error("key failed");
      }
    }
    const res = await fetch(`${servers.url}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "alice",
        password: "a-long-passphrase",
        name: "t",
        scope: "ro",
      }),
    });
    token = ((await res.json()) as { token: string }).token;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const lists: [string, string, number][] = [
    ["/api/v1/user/orgs", "username", 3],
    ["/api/v1/user/pins", "name", 3],
    ["/api/v1/user/keys", "name", 3],
  ];

  for (const [path, field, total] of lists) {
    test(`${path}: shape, paging to the end, bad input refused`, async () => {
      const whole = (await (await get(path)).json()) as Page;
      expect(Array.isArray(whole.items)).toBe(true);
      expect(whole.items).toHaveLength(total);
      expect(whole.next_cursor).toBeNull();

      const walked = await walk(path, field);
      expect(walked.sizes).toEqual([2, 1]);
      expect(walked.names.sort()).toEqual(whole.items.map((x) => x[field]).sort());

      for (const bad of ["limit=0", "limit=201", "limit=abc", "limit=-1", "limit=1.5"]) {
        const res = await get(`${path}?${bad}`);
        expect(res.status).toBe(422);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_limit");
      }
      const res = await get(`${path}?cursor=${"x".repeat(161)}`);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_cursor");
      expect((await get(`${path}?limit=200`)).status).toBe(200);
      expect((await fetch(`${servers.url}${path}`)).status).toBe(401);
    });
  }

  test("a key deleted between two pages skips nothing", async () => {
    const first = (await (await get("/api/v1/user/keys?limit=1")).json()) as Page;
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const gone = deleteSshKey(app, aliceUser, String(first.items[0]!.id));
    expect(gone.ok).toBe(true);
    const second = (await (
      await get(`/api/v1/user/keys?limit=5&cursor=${encodeURIComponent(first.next_cursor!)}`)
    ).json()) as Page;
    expect(second.items).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
  });

  test("a pin with a 100-character name pages across its boundary", async () => {
    const name = "n".repeat(100);
    const made = await createRepo(app, aliceUser, { name, visibility: "private" });
    if (!made.ok) throw new Error(`repo failed: ${made.error}`);
    pinRepo(app, aliceUser, made.value);
    const seen: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q: string = `limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await get(`/api/v1/user/pins?${q}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      seen.push(...page.items.map((x) => x.name));
      cursor = page.next_cursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(4);
    expect(seen).toContain(name);
  });
});
