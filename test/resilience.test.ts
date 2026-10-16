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
import { createUser } from "../src/core/users.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import { resilienceLines } from "../src/tui/screens/resilience.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DOC = `# Threats

## A stolen token

- Tokens carry a scope.
  Test: \`test/tokens.test.ts\`
- Revoking every token at once.
  Test: none yet

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

  test("the real docs/THREATS.md yields one protection per Test: line and per → row", async () => {
    const md = await Bun.file(join(import.meta.dir, "..", "docs", "THREATS.md")).text();
    const tests = md.split("\n").filter((l) => /^\s*Test: /.test(l)).length;
    const rows = md.split("\n").filter((l) => l.startsWith("| ") && l.includes("→")).length;
    const got = parseThreats(md);
    expect(got.length).toBe(tests + rows);
    expect(got.some((p) => p.test === "test/release-swap.test.ts" && p.text.includes("SO_REUSEPORT"))).toBe(true);
  });

  test("an unindented Test: line closes the paragraph above it", () => {
    const got = parseThreats("## X\n\nA prose protection.\nTest: `test/a.test.ts`\n");
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
});
