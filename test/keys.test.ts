/**
 * SSH public keys: strict parsing of real ssh-keygen output, ownership-scoped
 * deletion, forge-wide fingerprint uniqueness, and the API + web round trips.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSshKey, deleteSshKey } from "../src/actions/users.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import {
  findKeyByFingerprint,
  fingerprint,
  listKeys,
  parseAuthorizedKey,
} from "../src/core/keys.ts";
import type { User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { missing } from "./helpers/tools.ts";
import { fixtureSlot } from "./helpers/slot.ts";

/** Real keys come from real ssh-keygen; without it these skip, loudly. */
const NO_KEYGEN = missing("ssh-keygen");

async function keygen(dir: string, name: string, args: string[]) {
  const file = join(dir, name);
  const proc = Bun.spawn(
    ["ssh-keygen", "-q", "-N", "", "-C", `${name}@test`, "-f", file, ...args],
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(
      `ssh-keygen failed: ${await new Response(proc.stderr).text()}`,
    );
  return (await readFile(`${file}.pub`, "utf8")).trim();
}

describe.skipIf(NO_KEYGEN)("ssh keys", () => {
  let dataDir: string;
  let keyDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let ed25519 = "";
  let ecdsa = "";
  let rsa = "";
  let rsa1024 = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-keys-"));
    keyDir = await mkdtemp(join(tmpdir(), "forge-keygen-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await signUp(app, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    }, { slot: fixtureSlot(app) });
    const b = await signUp(app, {
      username: "bob",
      email: "bob@forge.test",
      password: "a-long-passphrase",
    }, { slot: fixtureSlot(app) });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    [ed25519, ecdsa, rsa, rsa1024] = await Promise.all([
      keygen(keyDir, "ed", ["-t", "ed25519"]),
      keygen(keyDir, "ec", ["-t", "ecdsa", "-b", "384"]),
      keygen(keyDir, "rsa", ["-t", "rsa", "-b", "2048"]),
      keygen(keyDir, "rsa1024", ["-t", "rsa", "-b", "1024"]),
    ]);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(keyDir, { recursive: true, force: true });
  });

  test("parses real ssh-keygen output for every supported algorithm", () => {
    for (const [line, algo] of [
      [ed25519, "ssh-ed25519"],
      [ecdsa, "ecdsa-sha2-nistp384"],
      [rsa, "ssh-rsa"],
    ] as const) {
      const parsed = parseAuthorizedKey(line);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.algo).toBe(algo);
      expect(parsed.value.comment).toMatch(/@test$/);
    }
  });

  test("the fingerprint matches ssh-keygen -lf", async () => {
    const proc = Bun.spawn(["ssh-keygen", "-lf", join(keyDir, "ed.pub")], {
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const parsed = parseAuthorizedKey(ed25519);
    if (!parsed.ok) throw new Error("parse failed");
    expect(out).toContain(fingerprint(parsed.value.blob));
  });

  test("rejects malformed and undersized keys", () => {
    const [type, b64 = ""] = ed25519.split(" ");
    // Declared type disagrees with the blob's inner type.
    expect(parseAuthorizedKey(`ssh-rsa ${b64}`).ok).toBe(false);
    expect(parseAuthorizedKey(`ecdsa-sha2-nistp256 ${b64}`).ok).toBe(false);
    // Garbage, empty, unknown type, bad base64, oversize.
    expect(parseAuthorizedKey("").ok).toBe(false);
    expect(parseAuthorizedKey("ssh-ed25519").ok).toBe(false);
    expect(parseAuthorizedKey("ssh-dss AAAA").ok).toBe(false);
    expect(parseAuthorizedKey(`${type} not*base64*`).ok).toBe(false);
    expect(parseAuthorizedKey(`${type} ${b64}!`).ok).toBe(false);
    expect(parseAuthorizedKey(`${type} ${b64.slice(0, -4)}`).ok).toBe(false);
    expect(parseAuthorizedKey(`${type} ${"A".repeat(20_000)}`).ok).toBe(false);
    // A blob with trailing bytes is not the key it claims to be.
    const padded = Buffer.concat([
      Buffer.from(b64, "base64"),
      Buffer.from([0]),
    ]).toString("base64");
    expect(parseAuthorizedKey(`${type} ${padded}`).ok).toBe(false);
    // RSA below 2048 bits.
    expect(parseAuthorizedKey(rsa1024)).toEqual({
      ok: false,
      error: "invalid_key",
    });
  });

  test("adding a key records an event; a duplicate is refused across users", () => {
    const added = addSshKey(app, alice, { name: "laptop", key: ed25519 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.fingerprint.startsWith("SHA256:")).toBe(true);
    expect(added.value.key).toBe(ed25519.split(" ").slice(0, 2).join(" "));
    expect(
      listEvents(app.db, {}).some(
        (e) =>
          e.kind === "user.key_added" &&
          e.actorId === alice.id &&
          e.payload.fingerprint === added.value.fingerprint,
      ),
    ).toBe(true);

    expect(addSshKey(app, alice, { name: "again", key: ed25519 })).toEqual({
      ok: false,
      error: "key_exists",
    });
    expect(addSshKey(app, bob, { name: "stolen", key: ed25519 })).toEqual({
      ok: false,
      error: "key_exists",
    });
    expect(addSshKey(app, undefined, { name: "x", key: ecdsa })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(addSshKey(app, bob, { name: "x", key: "junk" })).toEqual({
      ok: false,
      error: "invalid_key",
    });

    const match = findKeyByFingerprint(app.db, added.value.fingerprint);
    expect(match?.userId).toBe(alice.id);
    expect(match?.algo).toBe("ssh-ed25519");
  });

  test("a name falls back to the key's comment", () => {
    const added = addSshKey(app, bob, { name: "   ", key: ecdsa });
    expect(added.ok && added.value.name).toBe("ec@test");
  });

  test("deletion is scoped to the owner", () => {
    const [aliceKey] = listKeys(app.db, alice.id);
    expect(aliceKey).toBeDefined();
    expect(deleteSshKey(app, bob, aliceKey!.id)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(listKeys(app.db, alice.id)).toHaveLength(1);
    expect(deleteSshKey(app, alice, aliceKey!.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(listKeys(app.db, alice.id)).toHaveLength(0);
    expect(findKeyByFingerprint(app.db, aliceKey!.fingerprint)).toBeUndefined();
    expect(
      listEvents(app.db, {}).some((e) => e.kind === "user.key_removed"),
    ).toBe(true);
  });

  test("API round trip: add, list, delete — and ro tokens cannot add", async () => {
    const mint = async (scope: string) => {
      const res = await fetch(`${base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true,
          username: "alice",
          password: "a-long-passphrase",
          name: scope,
          scope,
        }),
      });
      return ((await res.json()) as { token: string }).token;
    };
    const rw = await mint("rw");
    const ro = await mint("ro");
    const headers = (token: string) => ({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });

    const refused = await fetch(`${base}/api/v1/user/keys`, {
      method: "POST",
      headers: headers(ro),
      body: JSON.stringify({ name: "ro", key: rsa }),
    });
    expect(refused.status).toBe(403);

    const created = await fetch(`${base}/api/v1/user/keys`, {
      method: "POST",
      headers: headers(rw),
      body: JSON.stringify({ name: "ci", key: rsa }),
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as {
      id: string;
      algo: string;
      fingerprint: string;
      key: string;
    };
    expect(key.algo).toBe("ssh-rsa");
    expect(key.key.startsWith("ssh-rsa ")).toBe(true);

    const invalid = await fetch(`${base}/api/v1/user/keys`, {
      method: "POST",
      headers: headers(rw),
      body: JSON.stringify({ name: "bad", key: rsa1024 }),
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: string }).error).toBe(
      "invalid_key",
    );

    const listed = await fetch(`${base}/api/v1/user/keys`, {
      headers: headers(ro),
    });
    const keys = ((await listed.json()) as { items: { id: string }[] }).items;
    expect(keys.map((k) => k.id)).toEqual([key.id]);

    expect((await fetch(`${base}/api/v1/user/keys`)).status).toBe(401);

    const removed = await fetch(`${base}/api/v1/user/keys/${key.id}`, {
      method: "DELETE",
      headers: headers(rw),
    });
    expect(removed.status).toBe(204);
    const gone = await fetch(`${base}/api/v1/user/keys/${key.id}`, {
      method: "DELETE",
      headers: headers(rw),
    });
    expect(gone.status).toBe(404);
  });

  test("web round trip: the settings page adds and removes a key", async () => {
    const signin = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-long-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = signin.headers.get("set-cookie")!.split(";")[0]!;

    const empty = await (
      await fetch(`${base}/settings/keys`, { headers: { cookie } })
    ).text();
    expect(empty).toContain("No SSH keys yet");

    const added = await fetch(`${base}/settings/keys`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "desk", key: ed25519 }),
      redirect: "manual",
    });
    expect(added.status).toBe(303);
    const [key] = listKeys(app.db, alice.id);
    expect(key?.name).toBe("desk");

    const listed = await (
      await fetch(`${base}/settings/keys`, { headers: { cookie } })
    ).text();
    expect(listed).toContain("desk");
    expect(listed).toContain(key!.fingerprint);

    const bad = await fetch(`${base}/settings/keys`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "bad", key: "nonsense" }),
      redirect: "manual",
    });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain("supported public key");

    // Cross-origin submissions are refused like every other form.
    const csrf = await fetch(`${base}/settings/keys/${key!.id}/delete`, {
      method: "POST",
      headers: { cookie, origin: "http://evil.example" },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(csrf.status).toBe(403);
    expect(listKeys(app.db, alice.id)).toHaveLength(1);

    const removed = await fetch(`${base}/settings/keys/${key!.id}/delete`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(removed.status).toBe(303);
    expect(listKeys(app.db, alice.id)).toHaveLength(0);

    expect(
      (await fetch(`${base}/settings/keys`, { redirect: "manual" })).status,
    ).toBe(303);
  });
});
