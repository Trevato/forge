/**
 * The forge reports the version it is running (#756).
 *
 * The number comes from the build: the release passes the tag it is
 * building into the image, and the process reads that stamp back. These
 * tests hold the whole path together, from the tag in the release workflow
 * to the words on a page, so that the report cannot again name a release
 * other than the one that is running.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { noteProtection, resetProtection } from "../src/kernel/protection.ts";
import { running, runningLine, UNSTAMPED } from "../src/kernel/version.ts";

const ROOT = resolve(import.meta.dir, "..");
const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

describe("the stamp, as the process reads it", () => {
  test("a stamped forge says its version and commit", () => {
    const stamped = running({ FORGE_VERSION: "0.7.51", FORGE_COMMIT: COMMIT });
    expect(stamped).toEqual({ version: "0.7.51", commit: COMMIT });
    expect(runningLine(stamped)).toBe("0.7.51 · abcdef0");
  });

  test("a tag and a version are the same version", () => {
    expect(running({ FORGE_VERSION: "v0.7.51" }).version).toBe("0.7.51");
    // A preview image's tag is a version too.
    expect(running({ FORGE_VERSION: "0.0.0-pr.806.6b7834e" }).version).toBe(
      "0.0.0-pr.806.6b7834e",
    );
    // Only a tag's `v` is dropped, not a word's.
    expect(running({ FORGE_VERSION: "vnext" }).version).toBe("vnext");
  });

  test("a forge run from source says so, and names no commit", () => {
    expect(running({})).toEqual({ version: UNSTAMPED, commit: null });
    expect(running({ FORGE_VERSION: "", FORGE_COMMIT: "" })).toEqual({
      version: "dev",
      commit: null,
    });
    expect(runningLine(running({}))).toBe("dev");
  });

  test("a stamp that does not look like one is no stamp", () => {
    for (const version of [
      "<b>1.0</b>",
      "1.0 beta",
      "1.0\n2.0",
      "-rf",
      "x".repeat(65),
    ])
      expect(running({ FORGE_VERSION: version }).version).toBe("dev");
    for (const commit of ["HEAD", "abc", "abcdef0; id", "g".repeat(40)])
      expect(running({ FORGE_COMMIT: commit }).commit).toBeNull();
    expect(running({ FORGE_COMMIT: ` ${COMMIT.toUpperCase()}\n` }).commit).toBe(
      COMMIT,
    );
  });

  test("a forge another forge runs as an app reports the commit it was started from", () => {
    expect(running({ FORGE_APP_COMMIT: COMMIT })).toEqual({
      version: "dev",
      commit: COMMIT,
    });
    // The build's own stamp wins.
    const other = "1".repeat(40);
    expect(
      running({ FORGE_COMMIT: COMMIT, FORGE_APP_COMMIT: other }).commit,
    ).toBe(COMMIT);
  });
});

describe("the release tag reaches the report", () => {
  const workflow = readFileSync(
    join(ROOT, ".forgejo/workflows/release.yml"),
    "utf8",
  );
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

  /**
   * The environment an image built from the `Dockerfile` gives its process,
   * for the build arguments passed: `ARG` defaults, overridden by what was
   * passed, substituted into each `ENV` line in order.
   */
  function imageEnv(args: Record<string, string>): Record<string, string> {
    const known: Record<string, string> = {};
    const env: Record<string, string> = {};
    const value = (raw: string) =>
      raw
        .replace(/^"(.*)"$/, "$1")
        .replace(
          /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
          (_, name: string) => known[name] ?? env[name] ?? "",
        );
    for (const line of dockerfile.split("\n")) {
      const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(line);
      if (arg) known[arg[1]!] = args[arg[1]!] ?? value(arg[2] ?? "");
      if (!line.startsWith("ENV ")) continue;
      for (const pair of line.slice(4).trim().split(/\s+/)) {
        const [name, ...rest] = pair.split("=");
        env[name!] = value(rest.join("="));
      }
    }
    return env;
  }

  test("the workflow builds the image with the tag it was started by", () => {
    // The version is the tag without its `v`, and that is what the build is
    // given.
    expect(workflow).toContain('echo "V=${GITHUB_REF_NAME#v}" >> $GITHUB_ENV');
    expect(workflow).toContain('--opt build-arg:VERSION="$V"');
  });

  test("the image built for a tag reports that tag, and the commit it is given", () => {
    for (const tag of ["v0.7.51", "v1.0.0", "v12.34.56-rc.1"]) {
      // `${GITHUB_REF_NAME#v}`, as the workflow derives it.
      const V = tag.replace(/^v/, "");
      const built = running(imageEnv({ VERSION: V, COMMIT }));
      expect(built).toEqual({ version: V, commit: COMMIT });
      expect(`v${built.version}`).toBe(tag);
    }
  });

  test("an image built with no arguments says dev, never a number", () => {
    expect(running(imageEnv({}))).toEqual({ version: "dev", commit: null });
  });

  test("no file in the repository carries the number: package.json says 0.0.0, and nothing in src reads it", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    // Like the chart's appVersion: a placeholder the release never reads.
    expect(pkg.version).toBe("0.0.0");
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts"))
          for (const m of readFileSync(path, "utf8").matchAll(
            /(?:from|import\()\s*"([^"\n]*package\.json)"/g,
          ))
            if (resolve(dirname(path), m[1]!) === join(ROOT, "package.json"))
              readers.push(path.slice(ROOT.length + 1));
      }
    };
    walk(join(ROOT, "src"));
    expect(readers).toEqual([]);
  });
});

describe("where the stamp is read", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let admin: User;
  let adminToken = "";
  let memberToken = "";
  const before = {
    version: process.env["FORGE_VERSION"],
    commit: process.env["FORGE_COMMIT"],
  };
  const stamp = (version?: string, commit?: string): void => {
    if (version === undefined) delete process.env["FORGE_VERSION"];
    else process.env["FORGE_VERSION"] = version;
    if (commit === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = commit;
  };

  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const mcp = async (token: string, method: string, params: unknown) =>
    (
      (await (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json()) as any
    ).result;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-version-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    admin = await person("alice");
    const member = await person("bob");
    expect([admin.isAdmin, member.isAdmin]).toEqual([true, false]);
    adminToken = createToken(app.db, admin.id, "t", "ro").token;
    memberToken = createToken(app.db, member.id, "t", "ro").token;
    stamp("9.8.7", COMMIT);
  });

  afterAll(async () => {
    stamp(before.version, before.commit);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the health report says the stamp to anyone who asks", async () => {
    const health = (await (await fetch(`${base}/api/v1/health`)).json()) as any;
    expect([health.version, health.commit]).toEqual(["9.8.7", COMMIT]);
    // A site admin's fuller answer says the same.
    const full = (await (
      await fetch(`${base}/api/v1/health`, {
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json()) as any;
    expect([full.version, full.commit]).toEqual(["9.8.7", COMMIT]);
    expect(full.disk).toBeDefined();
  });

  test("the MCP server names its version, and its health tool gives the report", async () => {
    const init = await mcp(memberToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.serverInfo).toEqual({ name: "forge", version: "9.8.7" });
    const told = await mcp(memberToken, "tools/call", {
      name: "health",
      arguments: {},
    });
    const report = JSON.parse(told.content[0].text);
    expect([report.version, report.commit]).toEqual(["9.8.7", COMMIT]);
    expect(report.rollout.state).toBe("ok");
    // The forge's own vitals are a site admin's.
    expect(report.disk).toBeUndefined();
    const full = JSON.parse(
      (await mcp(adminToken, "tools/call", { name: "health", arguments: {} }))
        .content[0].text,
    );
    expect(full.version).toBe("9.8.7");
    expect(full.disk).toBeDefined();
  });

  test("a site admin reads it at the foot of every page; nobody else is shown it", async () => {
    const foot = (html: string): string =>
      (/<footer class="foot">[\s\S]*?<\/footer>/.exec(html)?.[0] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const page = async (cookie?: string) =>
      foot(
        await (
          await fetch(`${base}/explore`, {
            headers: cookie === undefined ? {} : { cookie },
          })
        ).text(),
      );
    expect(await page(await signIn("alice"))).toStartWith(
      "forge 9.8.7 · abcdef0",
    );
    for (const other of [await page(await signIn("bob")), await page()]) {
      expect(other).toStartWith("forge · yours to keep");
      expect(other).not.toContain("9.8.7");
    }
  });

  test("a forge with less than default protection says so to its admin alone, escaped", async () => {
    noteProtection("apps", { ok: false, reason: "<b>no bwrap</b>" });
    try {
      const get = async (cookie?: string) =>
        await (
          await fetch(`${base}/explore`, {
            headers: cookie === undefined ? {} : { cookie },
          })
        ).text();
      const admin = await get(await signIn("alice"));
      expect(admin).toContain('id="reduced-protection"');
      expect(admin).toContain("Reduced protection: apps (&lt;b&gt;no bwrap");
      expect(admin).not.toContain("<b>no bwrap");
      for (const other of [await get(await signIn("bob")), await get()])
        expect(other).not.toContain("reduced-protection");
    } finally {
      resetProtection();
    }
  });

  test("once the host is protected again the admin's page shows no notice", async () => {
    noteProtection("apps", { ok: false, reason: "x" });
    noteProtection("apps", { ok: true });
    const page = await (
      await fetch(`${base}/explore`, {
        headers: { cookie: await signIn("alice") },
      })
    ).text();
    expect(page).not.toContain("reduced-protection");
  });

  test("with no stamp every one of them says dev", async () => {
    stamp();
    try {
      const health = (await (
        await fetch(`${base}/api/v1/health`)
      ).json()) as any;
      expect([health.version, health.commit]).toEqual(["dev", null]);
      const init = await mcp(memberToken, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      expect(init.serverInfo.version).toBe("dev");
    } finally {
      stamp("9.8.7", COMMIT);
    }
  });
});
