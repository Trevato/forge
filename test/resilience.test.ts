/**
 * The Resilience page: each THREATS.md protection green, red, untested or
 * "no test yet", from the last gate's per-file results.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { fileResults, keepForgeGate, keepGate, readGate } from "../src/checks/gate_last.ts";
import { parseThreats, standing } from "../src/core/threats.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { ownerView } from "../src/actions/resilience.ts";
import { DOMAINS } from "../src/kernel/domains.ts";
import { ownerRows } from "../src/tui/screens/owner.ts";
import { resilienceLines } from "../src/tui/screens/resilience.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DOC = `# Threats

## A stolen token

- Tokens carry a scope.
  Enforced by: \`test/tokens.test.ts\`
- Revoking every token at once.
  Enforced by: none yet

| call | note | test |
| --- | --- | --- |
| runner → forge | bearer | \`test/passport.test.ts\` |
`;

describe("resilience", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-resilience-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("bullets and table rows parse, a missing citation is undefined", () => {
    const got = parseThreats(DOC).map((p) => [p.text, p.test]);
    expect(got).toEqual([
      ["Tokens carry a scope.", "test/tokens.test.ts"],
      ["Revoking every token at once.", undefined],
      ["runner → forge", "test/passport.test.ts"],
    ]);
  });

  test("the real docs/THREATS.md yields one protection per Enforced by: line and per → row", async () => {
    const md = await Bun.file(join(import.meta.dir, "..", "docs", "THREATS.md")).text();
    const tests = md.split("\n").filter((l) => /^\s*Enforced by: /.test(l)).length;
    const rows = md.split("\n").filter((l) => l.startsWith("| ") && l.includes("→")).length;
    const got = parseThreats(md);
    expect(got.length).toBe(tests + rows);
    expect(got.some((p) => p.test === "test/release-swap.test.ts" && p.text.includes("SO_REUSEPORT"))).toBe(true);
  });

  test("an unindented Enforced by: line closes the paragraph above it", () => {
    const got = parseThreats("## X\n\nA prose protection.\nEnforced by: `test/a.test.ts`\n");
    expect(got.map((p) => [p.text, p.test])).toEqual([["A prose protection.", "test/a.test.ts"]]);
  });

  test("a failed cited file is red, a passed one green, an unrun one untested, none is 'no test yet'", () => {
    const gate = fileResults([
      "test/tokens.test.ts:",
      "(pass) a",
      "(fail) b",
      "test/passport.test.ts:",
      "(pass) c",
    ]);
    expect(gate).toEqual({ "test/tokens.test.ts": "fail", "test/passport.test.ts": "pass" });
    const [a, b, c] = parseThreats(DOC);
    expect(standing(a!, gate)).toBe("red");
    expect(standing(b!, gate)).toBe("no test yet");
    expect(standing(c!, gate)).toBe("green");
    expect(standing(a!, {})).toBe("untested");
  });

  test("the last gate is kept and read back; garbage reads as nothing", () => {
    expect(readGate(dataDir)).toEqual({});
    keepGate(dataDir, ["test/a.test.ts:", "(fail) x"]);
    expect(readGate(dataDir)).toEqual({ "test/a.test.ts": "fail" });
    writeFileSync(join(dataDir, "checks", "gate-last.json"), "[1]");
    expect(readGate(dataDir)).toEqual({});
  });

  test("another repository's gate leaves the forge's record unchanged", () => {
    keepGate(dataDir, ["test/tokens.test.ts:", "(fail) x"]);
    keepForgeGate(dataDir, "o/forge", "o/shop", ["test/tokens.test.ts:", "(pass) y"]);
    keepForgeGate(dataDir, undefined, "o/shop", ["test/other.test.ts:", "(pass) y"]);
    expect(readGate(dataDir)).toEqual({ "test/tokens.test.ts": "fail" });
    keepForgeGate(dataDir, "o/forge", "o/forge", ["test/tokens.test.ts:", "(pass) y"]);
    expect(readGate(dataDir)).toEqual({ "test/tokens.test.ts": "pass" });
  });

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };

  test("a guest is sent to sign in, a non-admin gets 404, an admin sees the rows", async () => {
    for (const [name, admin] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        ...(admin ? { adminIfFirst: true } : {}),
      });
      if (!made.ok) throw new Error(made.error);
    }
    mkdirSync(join(dataDir, "checks"), { recursive: true });
    keepGate(dataDir, ["test/tokens.test.ts:", "(fail) tokens are shown once"]);

    const guest = await fetch(`${servers.url}/resilience`, { redirect: "manual" });
    expect(guest.status).not.toBe(200);
    expect(guest.status).not.toBe(404);
    const bob = await fetch(`${servers.url}/resilience`, { headers: { cookie: await login("bob") } });
    expect(bob.status).toBe(404);
    expect(await bob.text()).not.toContain("data-standing");

    const res = await fetch(`${servers.url}/resilience`, { headers: { cookie: await login("alice") } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const row = text.split("<li").find((r) => r.includes("test/tokens.test.ts") && r.includes("data-standing"));
    expect(row).toContain('data-standing="red"');
    expect(text).toContain('data-standing="no test yet"');
  });

  test("in the terminal, an admin's Resilience command lists the standings; the others are not offered it", () => {
    const command = (admin: boolean) => {
      const pushed: Screen[] = [];
      const ctx = { push: (x: Screen) => pushed.push(x) } as unknown as Ctx;
      const user = app.db.query("SELECT * FROM user WHERE username = ?1").get(admin ? "alice" : "bob");
      const session = new Session(app, {
        sshUsername: "git",
        remoteAddress: "127.0.0.1",
        fingerprint: "SHA256:test",
        user: { ...(user as object), isAdmin: admin } as never,
      });
      return { found: forgeCommands(session)(ctx).find((c) => c.id === "resilience"), pushed };
    };
    const { found, pushed } = command(true);
    found!.run();
    expect(pushed.map((x) => x.title)).toEqual(["Resilience"]);
    expect(resilienceLines(dataDir).join("\n")).toContain("red");
    expect(command(false).found).toBeUndefined();
  });

  test("the owner's screen: needs, snapshots and every domain for an admin; nothing for the rest, and no command", async () => {
    const user = (n: string) => app.db.query("SELECT * FROM user WHERE username = ?1").get(n) as never;
    const alice = { ...(user("alice") as object), isAdmin: true } as never;
    const seen = await ownerView(app, alice);
    if (!seen.ok) throw new Error("admin refused");
    expect(seen.value.domains.map((d) => d.key)).toEqual(DOMAINS.map((d) => d.key));
    expect(seen.value.snapshots.where).toBeNull();
    const text = ownerRows(seen.value).map((r) => `${r.title} ${r.meta}`).join("\n");
    expect(text).toContain("nowhere to put a snapshot");
    for (const d of DOMAINS) expect(text).toContain(d.name);
    expect(text).toContain(DOMAINS[0]!.owner);

    const bob = { ...(user("bob") as object), isAdmin: false } as never;
    expect((await ownerView(app, bob)).ok).toBe(false);
    expect((await ownerView(app, undefined)).ok).toBe(false);

    const command = (u: unknown) => {
      const pushed: Screen[] = [];
      const ctx = { push: (x: Screen) => pushed.push(x) } as unknown as Ctx;
      const session = new Session(app, { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: u as never });
      return { found: forgeCommands(session)(ctx).find((c) => c.id === "owner"), pushed };
    };
    const a = command(alice);
    a.found!.run();
    expect(a.pushed.map((x) => x.title)).toEqual(["What needs the owner"]);
    expect(command(bob).found).toBeUndefined();
  });
});

describe("the owner's screen with snapshots", () => {
  let dir: string;
  let guard: string;
  let forge: App;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-owner-"));
    guard = await mkdtemp(join(tmpdir(), "forge-owner-guard-"));
    process.env["FORGE_GUARD_DIR"] = guard;
    forge = createApp({ dataDir: dir, port: 0 });
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
  });
  afterAll(async () => {
    delete process.env["FORGE_GUARD_DIR"];
    forge.close();
    await rm(dir, { recursive: true, force: true });
    await rm(guard, { recursive: true, force: true });
  });

  const alice = () => getUserByName(forge.db, "alice")!;
  const view = async () => {
    const got = await ownerView(forge, alice());
    if (!got.ok) throw new Error("admin refused");
    return got.value;
  };

  test("a store with a newest snapshot and a mirror: where, mirror, last, and the shared-volume need as an act row", async () => {
    const store = dirStore(join(dir, "snapshots"));
    const noMirror = startSnapshots(forge, store, { version: "t", nightly: false });
    try {
      const taken = await noMirror.now();
      const v = await view();
      expect(v.snapshots.where).toBe(store.where);
      expect(v.snapshots.mirror).toBeNull();
      expect(v.snapshots.last).toEqual({ at: taken.finishedAt, bytes: taken.bytes });
      const rows = ownerRows(v);
      const act = rows.filter((r) => r.title === "Needs" && r.secondary === "act");
      expect(act.map((r) => r.meta).join("\n")).toContain("Snapshots are kept on the forge's own volume");
      const snap = rows.find((r) => r.title === "Snapshots")!;
      expect(snap.secondary).toBe("kept");
      expect(snap.meta).toContain(`To ${store.where}, mirrored nowhere`);
      expect(snap.meta).toContain(`last ${taken.finishedAt.slice(0, 16).replace("T", " ")} UTC, ${taken.bytes} bytes`);
    } finally {
      await noMirror.stop();
    }

    const mirror = dirStore(join(dir, "mirror"));
    const mirrored = startSnapshots(forge, store, { version: "t", nightly: false, mirror, mirrorEveryMs: 3_600_000 });
    try {
      const v = await view();
      expect(v.snapshots.mirror).toBe(mirror.where);
      const rows = ownerRows(v);
      expect(rows.find((r) => r.title === "Snapshots")!.meta).toContain(`mirrored to ${mirror.where}`);
      const act = rows.filter((r) => r.title === "Needs" && r.secondary === "act");
      // Only this need: other rows (a mirror pass, a failed run) read the machine's state, not this test's.
      expect(act.map((r) => r.meta).join("\n")).not.toContain("Snapshots are kept on the forge's own volume");
    } finally {
      await mirrored.stop();
    }
    // A snapshot copies the database and fsyncs: on a loaded check machine it outlasts the 5 s default.
  }, 30_000);

  test("a store whose list() throws gives last=null and no crash; an empty store reads none yet", async () => {
    const broken: Store = { ...dirStore(join(dir, "broken")), list: () => Promise.reject(new Error("bucket gone")) };
    const svc = startSnapshots(forge, broken, { version: "t", nightly: false });
    try {
      const v = await view();
      expect(v.snapshots.where).toBe(broken.where);
      expect(v.snapshots.last).toBeNull();
      expect(ownerRows(v).find((r) => r.title === "Snapshots")!.secondary).toBe("none yet");
    } finally {
      await svc.stop();
    }
  });

  test("the screen loads and renders the rows in the terminal", async () => {
    const svc = startSnapshots(forge, dirStore(join(dir, "snapshots")), { version: "t", nightly: false });
    try {
      const terminal = headlessTerminal(140, 32);
      const user = alice();
      const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
      app.start();
      const press = async (...keys: string[]) => {
        for (const k of keys) app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
        await settleApp(app);
      };
      app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await press(..."Owner's needs", "enter");
      await settleApp(app);
      const text = app.screen.toText();
      expect(text).toContain("The forge's needs, its snapshots");
      expect(text).toContain("Needs");
      expect(text).toContain("Snapshots");
      app.stop();
    } finally {
      await svc.stop();
    }
  });
});
