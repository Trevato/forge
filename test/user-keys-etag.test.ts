/** GET /api/v1/user/keys is tagged and answers a repeat 304 until one of the viewer's SSH keys changes (#9243). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addSshKey } from "../src/actions/users.ts";
import { deleteKey, touchKey } from "../src/core/keys.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let tokens: Record<string, string>;
let seed = 1;

/** A fresh, well-formed ssh-ed25519 public key line. */
function freshKey(): string {
  const field = (b: Uint8Array) => {
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length);
    out.set(b, 4);
    return out;
  };
  const algo = field(new TextEncoder().encode("ssh-ed25519"));
  const pub = field(new Uint8Array(32).fill(seed++));
  return `ssh-ed25519 ${Buffer.concat([algo, pub]).toString("base64")} test`;
}

function addKey(who: User, name: string) {
  const r = addSshKey(app, who, { name, key: freshKey() });
  if (!r.ok) throw new Error(String(r.error));
  return r.value;
}

const get = (token: string | undefined, etag?: string) =>
  fetch(`${servers.url}/api/v1/user/keys`, {
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(etag === undefined ? {} : { "if-none-match": etag }),
    },
  });
const tagOf = async (who: string) => {
  const res = await get(tokens[who]);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, allowReserved: true,
      email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  await mk("root", true);
  alice = await mk("alice");
  bob = await mk("bob");
  tokens = {
    alice: createToken(app.db, alice.id, "t", "ro").token,
    bob: createToken(app.db, bob.id, "t", "ro").token,
  };
  addKey(alice, "laptop");
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("GET /api/v1/user/keys etag", () => {
  test("carries a weak tag, private no-cache and vary; the body is unchanged", async () => {
    const res = await get(tokens.alice);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
    const body = (await res.json()) as { items: { name: string }[]; next_cursor: string | null };
    expect(body.items.map((k) => k.name)).toEqual(["laptop"]);
    expect(body.next_cursor).toBeNull();
  });

  test("a repeat is a 304 with the same headers, no body and the security floor", async () => {
    const tag = await tagOf("alice");
    const res = await get(tokens.alice, tag);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(tag);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
    expect(res.headers.get("referrer-policy")).not.toBeNull();
  });

  test("no session is a 401 with no tag, even with If-None-Match: *", async () => {
    const res = await get(undefined, "*");
    expect(res.status).toBe(401);
    expect(res.headers.get("etag")).toBeNull();
  });

  test("a token that does not hold is a 401 with no tag, even with If-None-Match: *", async () => {
    const res = await get("forge_not-a-real-token", "*");
    expect(res.status).toBe(401);
    expect(res.headers.get("etag")).toBeNull();
  });

  test("two viewers shown different bodies never share a tag", async () => {
    const [a, b] = [await tagOf("alice"), await tagOf("bob")];
    expect(a).not.toBe(b);
    expect((await get(tokens.bob, a)).status).toBe(200);
  });

  test("adding a key changes the tag", async () => {
    const tag = await tagOf("alice");
    addKey(alice, "desktop");
    expect((await get(tokens.alice, tag)).status).toBe(200);
  });

  test("removing a key changes the tag", async () => {
    const k = addKey(alice, "spare");
    const tag = await tagOf("alice");
    deleteKey(app.db, alice.id, k.id);
    expect((await get(tokens.alice, tag)).status).toBe(200);
  });

  test("a key's last use changes the tag", async () => {
    const k = addKey(alice, "used");
    const tag = await tagOf("alice");
    app.db.run("UPDATE user_key SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [k.id]);
    expect((await get(tokens.alice, tag)).status).toBe(200);
    const again = await tagOf("alice");
    touchKey(app.db, k.id);
    expect((await get(tokens.alice, again)).status).toBe(200);
  });

  test("another viewer's key does not change it", async () => {
    const tag = await tagOf("alice");
    addKey(bob, "bobs");
    expect((await get(tokens.alice, tag)).status).toBe(304);
  });
});
