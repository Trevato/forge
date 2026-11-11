/**
 * The app a new app starts as keeps its own promises. The scaffold is
 * written out as a person would get it, and its own suite runs there: the
 * tokens compile and nothing spells out a colour, every change leaves an
 * audit row, the committed API description is what the routes say, the
 * door refuses a stranger before the body, `/healthz` answers. Then the
 * two scripts the app ships run as a person would run them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "../src/app.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { scaffoldFiles } from "../src/apps/scaffold.ts";

/** How long the written-out app's `bun test` may take, wall clock. */
const SUITE_BUDGET_MS = 3_000;

/**
 * A child that inherits nothing it was not handed. Its TMPDIR is a directory
 * made inside the test's own temp dir: the builder's sandbox holds anything
 * else read-only, and a child bun refuses to start without a tempdir it can
 * write (#11051).
 */
const run = async (
  cwd: string,
  argv: string[],
  temp: string,
): Promise<{ code: number; out: string }> => {
  const child = Bun.spawn(argv, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? cwd,
      TMPDIR: temp,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: out + err };
};

describe("a scaffolded app, written out and run on its own", () => {
  let scratch: string;
  let dir: string;
  let temp: string;
  const files = scaffoldFiles({ name: "field-notes", description: "" });
  const content = (path: string): string => {
    const file = files.find((f) => f.path === path);
    if (file === undefined || typeof file.content !== "string")
      throw new Error(`scaffold has no text file at ${path}`);
    return file.content;
  };

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "forge-scaffold-"));
    dir = join(scratch, "app");
    temp = join(scratch, "tmp");
    await mkdir(temp);
    for (const file of files) {
      const path = join(dir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content as string);
    }
  });
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  test("its own suite is green, inside its 3 s budget", async () => {
    // Every deploy and every pull on the app waits on this suite, so it is
    // held to a budget (docs/APPS.md, "What a new app starts as").
    const own = await mkdtemp(join(scratch, "suite-tmp-"));
    const started = performance.now();
    const { code, out } = await run(dir, [process.execPath, "test"], own);
    const ms = Math.round(performance.now() - started);
    console.log(`the scaffold's own suite ran in ${ms} ms (budget ${SUITE_BUDGET_MS} ms)`);
    expect([code, out.includes(" 0 fail")]).toEqual([0, true]);
    expect(ms).toBeLessThanOrEqual(SUITE_BUDGET_MS);
    // It leaves its temporary directory as it found it: a check cell's /tmp
    // is a small tmpfs every scaffolded suite in the forge's own check shares
    // (#5326), and every app's own check cell has one too.
    expect(await readdir(own)).toEqual([]);
    // Each guarantee has its own file of tests in the suite.
    for (const name of [
      "design.test.ts",
      "audit.test.ts",
      "openapi.test.ts",
      "security.test.ts",
      "server.test.ts",
      "contract.test.ts",
    ])
      expect(out).toContain(name);
  }, 60_000);

  test("the design lint passes, and refuses a colour spelled out", async () => {
    expect(
      (await run(dir, [process.execPath, "run", "lint:design"], temp)).code,
    ).toBe(0);
    const css = join(dir, "static", "app.css");
    const before = await readFile(css, "utf8");
    await writeFile(css, `${before}\n.oops { color: #ff0000; }\n`);
    const refused = await run(dir, [process.execPath, "run", "lint:design"], temp);
    await writeFile(css, before);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("static/app.css");
    expect(refused.out).toContain("raw colour #ff0000");
  }, 30_000);

  test("the committed API description is exactly what contract:emit writes", async () => {
    const committed = content("contract/openapi.json");
    const emitted = await run(dir, [process.execPath, "run", "contract:emit"], temp);
    expect(emitted.code).toBe(0);
    expect(await readFile(join(dir, "contract", "openapi.json"), "utf8")).toBe(
      committed,
    );
    const doc = JSON.parse(committed) as {
      info: { title: string; description: string };
    };
    expect(doc.info).toMatchObject({
      title: "field-notes",
      description: "A new app on the forge.",
    });
  }, 30_000);

  test("it typechecks under strict settings, with the forge's own type definitions", async () => {
    // The app ships no dependencies, so the checker borrows the forge's own
    // tsc and Bun types, run straight from node_modules: `bun x` would reach
    // for a package cache and the registry, neither of which a sandbox
    // promises (#11051). The app's code itself must be clean under the same
    // strictness the forge holds itself to.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const sources = [
      ...(await readdir(join(dir, "src"))).map((f) => join("src", f)),
      ...(await readdir(join(dir, "scripts"))).map((f) => join("scripts", f)),
    ].filter((f) => f.endsWith(".ts"));
    const { code, out } = await run(dir, [
      process.execPath,
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "esnext",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--allowImportingTsExtensions",
      "--noUncheckedIndexedAccess",
      "--exactOptionalPropertyTypes",
      "--types",
      "bun-types",
      "--typeRoots",
      `${root}node_modules/@types,${root}node_modules`,
      ...sources,
    ], temp);
    // tsc's exit code is the verdict. On a failure, the output is the
    // reason, so the assertion shows it beside the code.
    expect({ code, out: code === 0 ? "" : out.trim() }).toEqual({ code: 0, out: "" });
  }, 120_000);

  test("forge.json points the forge's health poll at /healthz", () => {
    const manifest = parseManifest(
      content("forge.json"),
      content("package.json"),
    );
    expect(manifest.ok).toBe(true);
    if (manifest.ok) expect(manifest.value.health).toBe("/healthz");
  });
});

describe("a scaffolded app signs a person in through the forge", () => {
  test("OpenID Connect, code flow with PKCE: register, consent, return, session", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-signin-"));
    const appDir = join(root, "app");
    const dataDir = join(root, "data");
    const temp = join(root, "tmp");
    await mkdir(temp);
    for (const file of scaffoldFiles({ name: "field-notes", description: "" })) {
      const path = join(appDir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content as string);
    }
    const forge = createApp({ dataDir: join(root, "forge"), port: 0 });
    const servers = await serve(forge);
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const person = `forge_session=${createSession(forge.db, made.value.id).token}`;
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    const base = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([process.execPath, "run", "src/server.ts"], {
      cwd: appDir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        PORT: String(port),
        HOST: "127.0.0.1",
        FORGE_APP_DATA: dataDir,
        FORGE_APP_URL: base,
        FORGE_URL: servers.url,
        TMPDIR: temp,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (let i = 0; i < 100; i++) {
        if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok) break;
        await Bun.sleep(100);
      }
      const manual = { redirect: "manual" as const };
      // It registered itself on first boot, and kept the client id.
      const registry = JSON.parse(
        await readFile(join(dataDir, "oidc-client.json"), "utf8"),
      ) as Record<string, string>;
      expect(Object.keys(registry)).toEqual([`${base}/signin/callback`]);

      // Out to the forge, bound to this browser.
      const out = await fetch(`${base}/signin`, manual);
      expect(out.status).toBe(303);
      const bound = /signin=([^;]+)/.exec(out.headers.get("set-cookie") ?? "")![1]!;
      expect(out.headers.get("set-cookie")).toContain("HttpOnly");
      const authorize = new URL(out.headers.get("location")!);
      expect(authorize.origin).toBe(servers.url);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

      // The person consents at the forge.
      const consent = await fetch(`${servers.url}/oauth/authorize`, {
        method: "POST",
        ...manual,
        headers: { cookie: person, origin: servers.url },
        body: new URLSearchParams({
          ...Object.fromEntries(authorize.searchParams),
          decision: "allow",
          grant: "ro",
          name: "field-notes",
          lifetime: "day",
        }),
      });
      expect(consent.status).toBe(303);
      const back = new URL(consent.headers.get("location")!);
      expect(`${back.origin}${back.pathname}`).toBe(`${base}/signin/callback`);

      // A return from a browser that did not start it is refused.
      const other = await fetch(back, { ...manual, headers: { cookie: "signin=other" } });
      expect(other.headers.get("set-cookie") ?? "").not.toContain("session=");

      // The right browser lands signed in.
      const landed = await fetch(back, { ...manual, headers: { cookie: `signin=${bound}` } });
      expect(landed.status).toBe(303);
      const cookies = landed.headers.getSetCookie().join("\n");
      const session = /(?:^|\n)session=([^;]+); .*HttpOnly/.exec(cookies)![1]!;
      const page = await (await fetch(base, { headers: { cookie: `session=${session}` } })).text();
      expect(page).toContain("<b>alice</b>");
      expect(page).toContain('action="/signout"');

      // The code was single-use: replaying the return signs nobody in.
      const replay = await fetch(back, { ...manual, headers: { cookie: `signin=${bound}` } });
      expect(replay.headers.getSetCookie().join("\n")).not.toMatch(/session=[^;]/);

      // Signed out, the session is gone.
      const out2 = await fetch(`${base}/signout`, {
        method: "POST",
        ...manual,
        headers: { cookie: `session=${session}`, origin: base },
      });
      expect(out2.status).toBe(303);
      const after = await (await fetch(base, { headers: { cookie: `session=${session}` } })).text();
      expect(after).not.toContain("<b>alice</b>");
    } finally {
      child.kill();
      servers.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
