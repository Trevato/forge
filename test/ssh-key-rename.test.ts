/**
 * Renaming an SSH key (#8091): your own key takes a new name and the bus
 * says so without the key material; another account's key and a name that
 * is empty, too long or carries control characters change nothing. Adding a
 * key holds its name to the same rule.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameSshKey } from "../src/actions/users.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { addKey, listKeys, parseAuthorizedKey, renameKey } from "../src/core/keys.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const line = (fill: number) => {
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, fill),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
};

describe("renaming an SSH key", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let keyId: string;

  const name = () => listKeys(app.db, alice.id).find((k) => k.id === keyId)!.name;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-key-rename-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const make = async (username: string, first: boolean) => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    alice = await make("alice", true);
    bob = await make("bob", false);
    const parsed = parseAuthorizedKey(line(7));
    if (!parsed.ok) throw new Error("bad fixture key");
    const added = addKey(app.db, alice.id, "laptop", parsed.value);
    if (!added.ok) throw new Error(added.error);
    keyId = added.value.id;
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("your own key is renamed, trimmed, and the bus carries its id only", () => {
    expect(renameSshKey(app, alice, keyId, "  work laptop  ")).toEqual({ ok: true, value: undefined });
    expect(name()).toBe("work laptop");
    const event = listEvents(app.db, {}).find((e) => e.kind === "user.key_renamed");
    expect(event?.actorId).toBe(alice.id);
    expect(event?.payload).toEqual({ keyId });
    expect(JSON.stringify(event)).not.toContain(line(7).split(" ")[1]!);
  });

  test("another account's key is refused and keeps its name", () => {
    expect(renameKey(app.db, bob.id, keyId, "mine now")).toBe(false);
    expect(renameSshKey(app, bob, keyId, "mine now")).toEqual({ ok: false, error: "not_found" });
    expect(renameSshKey(app, undefined, keyId, "mine now").ok).toBe(false);
    expect(name()).toBe("work laptop");
  });

  test("a bad name is refused and changes nothing", () => {
    for (const bad of ["", "   ", "x".repeat(65), "evil\x1b[2J", "tab\there", "line\nbreak", "rtl‮override"]) {
      expect(renameKey(app.db, alice.id, keyId, bad)).toBe(false);
      expect(renameSshKey(app, alice, keyId, bad)).toEqual({ ok: false, error: "invalid_name" });
    }
    expect(name()).toBe("work laptop");
    expect(renameKey(app.db, alice.id, keyId, "ü".repeat(64))).toBe(true);
  });

  test("an added key's name is held to the rename rule, so its prefill renames", () => {
    const add = (fill: number, raw: string) => {
      const parsed = parseAuthorizedKey(line(fill));
      if (!parsed.ok) throw new Error("bad fixture key");
      const added = addKey(app.db, alice.id, raw, parsed.value);
      if (!added.ok) throw new Error(added.error);
      return added.value;
    };
    const long = add(8, "y".repeat(90));
    expect(long.name).toBe("y".repeat(64));
    const painted = add(9, "evil\x1b[2Jbox\u202e");
    expect(painted.name).toBe("evil [2Jbox");
    expect(add(10, "\x07\x1b").name).toBe("ssh-ed25519");
    for (const k of [long, painted]) expect(renameKey(app.db, alice.id, k.id, k.name)).toBe(true);
  });
});
