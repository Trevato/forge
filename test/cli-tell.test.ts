/** `forge tell` against a fake `POST /api/v1/feed/tells`, run as a shell runs it. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/cli/main.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

let server: ReturnType<typeof Bun.serve>;
let base = "";
let dir = "";
let reply: () => Response = () => Response.json({ issue: 12 }, { status: 201 });
const seen: { auth: string | null; body: unknown }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tell-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/v1/feed/tells" || req.method !== "POST")
        return Response.json({ error: "not_found", message: "no" }, { status: 404 });
      seen.push({ auth: req.headers.get("authorization"), body: await req.json() });
      return reply();
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  for (const [name, remote] of [
    ["clone", `${base}/alice/shop.git`],
    ["other", "https://example.com/a/b.git"],
  ] as const) {
    Bun.spawnSync(["git", "init", "-q", join(dir, name)]);
    Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: join(dir, name) });
  }
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function forge(args: string[], cwd = join(dir, "clone")) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      FORGE_URL: base,
      FORGE_TOKEN: "tok",
      FORGE_CONFIG_DIR: dir,
      FORGE_KEYCHAIN: "0",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

test("posts the words about the folder's repository and prints the issue address", async () => {
  const run = await forge(["tell", "make", "the", "header", "smaller"]);
  expect(run.code).toBe(EXIT.ok);
  expect(seen.at(-1)).toEqual({
    auth: "Bearer tok",
    body: { app: "alice/shop", text: "make the header smaller" },
  });
  expect(run.out).toContain(`issue #12  ${base}/alice/shop/issues/12`);
});

test("`--` ends the options, so words may start with a dash", async () => {
  const run = await forge(["tell", "--", "--fast", "please"]);
  expect(run.code).toBe(EXIT.ok);
  expect((seen.at(-1)!.body as { text: string }).text).toBe("--fast please");
});

test("--variants and --from go to the API as given", async () => {
  const run = await forge([
    "tell", "try", "it", "--variants", "3", "--from", "/alice/shop/pulls/3",
  ]);
  expect(run.code).toBe(EXIT.ok);
  expect(seen.at(-1)!.body).toEqual({
    app: "alice/shop",
    text: "try it",
    variants: 3,
    from: "/alice/shop/pulls/3",
  });
});

test("a bad --variants or --from exits 2 without a request", async () => {
  const before = seen.length;
  const bads = [
    ["--variants", "9"],
    ["--variants", "x"],
    ["--from", "https://evil.example/"],
    ["--from", "/a b"],
    ["--from", "/a\"b"],
    ["--from", "//evil"],
  ];
  for (const bad of bads) {
    expect((await forge(["tell", "hi", ...bad])).code).toBe(EXIT.usage);
  }
  expect(seen.length).toBe(before);
});

test("--repo overrides the folder, even one that is not a clone", async () => {
  const run = await forge(["tell", "hi", "--repo", "bob/lab"], dir);
  expect(run.code).toBe(EXIT.ok);
  expect((seen.at(-1)!.body as { app: string }).app).toBe("bob/lab");
});

test("empty words print usage and exit 2 without a request", async () => {
  const before = seen.length;
  const run = await forge(["tell", "  "]);
  expect(run.code).toBe(EXIT.usage);
  expect(run.err).toContain("forge tell");
  expect(seen.length).toBe(before);
});

test("an origin elsewhere asks for --repo and exits 2", async () => {
  const run = await forge(["tell", "hi"], join(dir, "other"));
  expect(run.code).toBe(EXIT.usage);
  expect(run.err).toContain("--repo");
});

test("a refusal prints the API's words and exits 1; a 401 exits 3", async () => {
  reply = () =>
    Response.json({ error: "not_found", message: "no such repository" }, { status: 404 });
  const gone = await forge(["tell", "hi"]);
  expect(gone.code).toBe(EXIT.failed);
  expect(gone.err).toContain("no such repository");
  reply = () => Response.json({ error: "unauthorized", message: "bad token" }, { status: 401 });
  expect((await forge(["tell", "hi"])).code).toBe(EXIT.notConfigured);
  reply = () => Response.json({ issue: 12 }, { status: 201 });
});

test("not logged in exits 3", async () => {
  const proc = Bun.spawn(["bun", CLI, "tell", "hi"], {
    cwd: join(dir, "clone"),
    env: { PATH: process.env["PATH"] ?? "", HOME: dir, FORGE_CONFIG_DIR: join(dir, "empty"), FORGE_KEYCHAIN: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(EXIT.notConfigured);
});

test("help lists the command", async () => {
  expect((await forge(["help"])).out).toContain("forge tell");
});
