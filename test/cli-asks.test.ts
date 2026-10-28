/**
 * `forge asks` against a fake `/api/v1/asks`: the CLI run as a shell runs
 * it, a process reading only its environment, so the exit codes are real.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../src/cli/api.ts";
import { askLines, EXIT } from "../src/cli/main.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

const ANSWER = {
  waiting: { count: 4, stale: 0 },
  rows: [
    {
      id: "look:1",
      kind: "look",
      repo: "alice/shop",
      line: "shop: Pull #3 is green — look and merge",
      link: "/alice/shop/pulls/3",
      items: ["look:1"],
    },
    {
      id: "parked:2",
      kind: "parked",
      repo: "alice/notes",
      line: `notes: Issue #9 waits on a decision ${"about the long tail of things ".repeat(4)}end`,
      link: "/alice/notes/issues/9",
      items: ["parked:2"],
    },
    // A kind this client has never heard of, with no line: it still prints.
    { id: "x:3", kind: "brand-new", repo: "bob/lab", link: "/#ask-x-3", items: [] },
  ],
  forge: ["The check lane is stuck."],
  measure: { days: 7, raised: 1 },
};

let server: ReturnType<typeof Bun.serve>;
let base = "";
let configDir = "";
let reply: () => Response = () => Response.json(ANSWER);
const seen: string[] = [];

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "forge-asks-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(`${url.pathname} ${req.headers.get("authorization")}`);
      return url.pathname === "/api/v1/asks"
        ? reply()
        : Response.json({ error: "not_found", message: "no" }, { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await rm(configDir, { recursive: true, force: true });
});

async function forge(
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      FORGE_URL: base,
      FORGE_TOKEN: "tok",
      FORGE_CONFIG_DIR: configDir,
      FORGE_KEYCHAIN: "0",
      NO_COLOR: "1",
      ...extra,
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

test("prints one line per ask, in the API's order, every kind kept", async () => {
  reply = () => Response.json(ANSWER);
  const run = await forge(["asks"]);
  expect(run.code).toBe(EXIT.ok);
  expect(seen.at(-1)).toBe("/api/v1/asks Bearer tok");
  const lines = run.out.trimEnd().split("\n");
  expect(lines).toHaveLength(4);
  expect(lines[0]!.startsWith("1  look       alice/shop   Pull #3")).toBe(true);
  expect(lines[0]!.endsWith(`  ${base}/alice/shop/pulls/3`)).toBe(true);
  expect(lines[1]!.startsWith("2  parked     alice/notes  ")).toBe(true);
  expect(lines[1]!.endsWith(`…  ${base}/alice/notes/issues/9`)).toBe(true);
  // An unknown kind with no line prints its kind as its title.
  expect(lines[2]).toBe(`3  brand-new  bob/lab      brand-new  ${base}/#ask-x-3`);
  expect(lines[3]!.startsWith("4  forge                   The check")).toBe(true);
  expect(lines[3]!.endsWith(`  ${base}/`)).toBe(true);
  // A pipe has no width; the CLI takes 80 and leaves the last column free.
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(79);
});

const ASKS: Ask[] = [
  { kind: "look", repo: "alice/shop", title: "Pull #3 is green", url: "https://f.example/alice/shop/pulls/3" },
  { kind: "parked", repo: "alice/notes", title: "x".repeat(200), url: "https://f.example/alice/notes/issues/9" },
  { kind: "forge", repo: "", title: "The check lane is stuck.", url: "https://f.example/" },
];

test("askLines pads kind and repository and keeps short titles whole", () => {
  const lines = askLines(ASKS, 120);
  expect(lines[0]).toBe(
    "look    alice/shop   Pull #3 is green  https://f.example/alice/shop/pulls/3",
  );
  expect(lines[2]).toBe(
    "forge                The check lane is stuck.  https://f.example/",
  );
});

test("askLines cuts a long title so the line fits the width", () => {
  for (const width of [80, 100, 120]) {
    const line = askLines(ASKS, width)[1]!;
    expect(line.length).toBe(width - 1);
    expect(line.endsWith("…  https://f.example/alice/notes/issues/9")).toBe(true);
  }
});

test("askLines neutralises control characters a title carries", () => {
  const [line] = askLines(
    [{ kind: "look", repo: "a/b", title: "evil\x1b[2Jtitle", url: "https://f.example/" }],
    120,
  );
  expect(line).not.toContain("\x1b");
  expect(line).toContain("evil\ufffd[2Jtitle");
});

test("--repo keeps only that repository's asks", async () => {
  reply = () => Response.json(ANSWER);
  const run = await forge(["asks", "--repo", "alice/notes"]);
  expect(run.code).toBe(EXIT.ok);
  const lines = run.out.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]!.startsWith("1  parked  alice/notes  Issue #9")).toBe(true);

  const none = await forge(["asks", "--repo", "carol/elsewhere"]);
  expect(none.out).toBe("Nothing waits on you.\n");
  expect(none.code).toBe(EXIT.ok);

  const bad = await forge(["asks", "--repo", "nope"]);
  expect(bad.code).toBe(EXIT.usage);
  expect(bad.err).toContain("owner/name");
});

test("--json prints the API's answer unchanged", async () => {
  reply = () => Response.json(ANSWER);
  const run = await forge(["asks", "--json"]);
  expect(run.code).toBe(EXIT.ok);
  expect(JSON.parse(run.out)).toEqual(ANSWER);
});

test("--json --repo prints the API's answer with only that repository's rows", async () => {
  reply = () => Response.json(ANSWER);
  const run = await forge(["asks", "--json", "--repo", "alice/notes"]);
  expect(run.code).toBe(EXIT.ok);
  const body = JSON.parse(run.out);
  expect(body.rows).toEqual([ANSWER.rows[1]]);
  expect(body.forge).toEqual([]);
  expect(body.waiting).toEqual(ANSWER.waiting);
  expect(body.measure).toEqual(ANSWER.measure);
});

test("nothing waiting prints one sentence and exits 0", async () => {
  reply = () => Response.json({ waiting: { count: 0, stale: 0 }, rows: [], forge: [] });
  const run = await forge(["asks"]);
  expect(run.out).toBe("Nothing waits on you.\n");
  expect(run.code).toBe(EXIT.ok);
});

test("a refusal prints the API's words and exits with the matching code", async () => {
  reply = () =>
    Response.json({ error: "unauthorized", message: "Sign in first." }, { status: 401 });
  const signedOut = await forge(["asks"]);
  expect(signedOut.code).toBe(EXIT.notConfigured);
  expect(signedOut.err).toBe("forge asks: Sign in first.\n");

  reply = () =>
    Response.json({ error: "forbidden", message: "This token cannot read asks." }, { status: 403 });
  const refused = await forge(["asks"]);
  expect(refused.code).toBe(EXIT.failed);
  expect(refused.err).toBe("forge asks: This token cannot read asks.\n");
});

test("not logged in exits notConfigured without calling the forge", async () => {
  const before = seen.length;
  const run = await forge(["asks"], {
    FORGE_URL: "",
    FORGE_TOKEN: "",
    FORGE_CONFIG_DIR: join(configDir, "empty"),
  });
  expect(run.code).toBe(EXIT.notConfigured);
  expect(run.err).toContain("forge login");
  expect(seen.length).toBe(before);
});

test("forge help lists the command", async () => {
  const run = await forge(["help"]);
  expect(run.out).toContain("forge asks");
  expect(run.out).toContain("--repo owner/name");
});
