/**
 * Every response leaves through a listener, so the floor is proven at the
 * listeners (#10949). A `new Response(` anywhere in src/ — html, text, a
 * redirect, a stream — reaches a client only as the answer of some
 * `Bun.serve` fetch; this test lists every one of those in src/ with why
 * what it returns carries the security floor, and fails on a listener it
 * has not been told about. Then it walks the public door's own returns,
 * and asks the running forge for answers that are not JSON.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { securityFloor } from "../src/http/respond.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { openBeatDoor } from "../src/spawn/beat-door.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ROOT = join(import.meta.dir, "..");
const FLOOR = ["content-security-policy", "x-content-type-options", "referrer-policy"] as const;

/** file → how many `Bun.serve(` it holds, and why each floors or is not a door. */
const LISTENERS: Record<string, { count: number; why: string }> = {
  "src/http/server.ts": {
    count: 2,
    why: "the public door (`handle`, walked below) and the internal hook listener, whose fetch is `securityFloor(await answerInternal(...))`",
  },
  "src/spawn/beat-door.ts": { count: 1, why: "fetch is `securityFloor(await answerBeat(...))`, asked below" },
  "src/kernel/port.ts": { count: 1, why: "a port probe, stopped before any request can reach it" },
  "src/apps/process.ts": { count: 1, why: "a port probe, stopped before any request can reach it" },
  "src/apps/scaffold.ts": { count: 1, why: "text of another app's server, written into its repository; it lays its own floor" },
  "src/actions/spawn.ts": { count: 1, why: "text of a fresh app's index.ts, written into its repository" },
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

test("every listener in src/ is named, with why its answers carry the floor", () => {
  const found: Record<string, number> = {};
  for (const file of sources(join(ROOT, "src"))) {
    const n = readFileSync(file, "utf8").split("Bun.serve(").length - 1;
    if (n > 0) found[relative(ROOT, file)] = n;
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(LISTENERS).map(([f, l]) => [f, l.count])));
});

test("the internal listener and the beat door hand their fetch to securityFloor", () => {
  const server = readFileSync(join(ROOT, "src/http/server.ts"), "utf8");
  expect(server).toContain("fetch: async (request) => securityFloor(await answerInternal(app, request)),");
  const beat = readFileSync(join(ROOT, "src/spawn/beat-door.ts"), "utf8");
  expect(beat).toContain("fetch: async (req) => securityFloor(await answerBeat(app, deps, req)),");
});

/**
 * What the public door may return: an answer it floored itself, one that
 * came through `answered` (which floors after compressing), a cell's or an
 * app's own (the app's headers are the app's business, `apps/proxy.ts`), or
 * nothing after an upgrade.
 */
const DOOR_RETURNS = [
  /^securityFloor\(/,
  /^response;$/,
  /^withHeader\(response, "connection", "close"\);$/,
  /^proxyApp\(/,
  /^fromCell\(/,
  /^undefined;$/,
  /^socket === undefined \? undefined : securityFloor\(socket\);$/,
  /^first;$/,
  /^done;$/,
];

test("each return of the public door and of `answered` is floored", () => {
  const server = readFileSync(join(ROOT, "src/http/server.ts"), "utf8");
  const from = server.indexOf("  const answered = async (");
  const to = server.indexOf("  const web = Bun.serve(");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const region = server.slice(from, to);
  const code = region
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const returns = [...code.matchAll(/\breturn\s+([^\n]+)/g)].map((m) => m[1]!.trim());
  expect(returns.length).toBeGreaterThan(10);
  expect(returns.filter((r) => !DOOR_RETURNS.some((p) => p.test(r)))).toEqual([]);
  // `response` is only ever what `answered` gave back.
  for (const m of region.matchAll(/\bresponse\s*=\s*([^\n;]+)/g)) expect(m[1]!.trim()).toMatch(/^await answered\(/);
  // `answered` floors what the work returns, and its failure path floors too.
  expect(region).toContain("const done = await compress(request, response).then(securityFloor)");
  expect(server).toMatch(/function failure\([^]*?\n}\n/);
  const failure = server.match(/function failure\([^]*?\n}\n/)![0];
  for (const r of failure.matchAll(/\breturn\s+([^\n]+)/g)) expect(r[1]!.trim()).toMatch(/^securityFloor\(/);
});

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-floor-doors-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const lacks = (res: Response): string[] => FLOOR.filter((h) => !res.headers.get(h));

test("an html page, a redirect and plain text through the door carry the floor", async () => {
  const ask = (path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, { redirect: "manual", ...init, headers: { accept: "text/html", ...init.headers } });
  const page = await ask("/");
  expect(page.headers.get("content-type")).toStartWith("text/html");
  expect(lacks(page)).toEqual([]);
  // An html page writes its own policy; the floor keeps it.
  expect(page.headers.get("content-security-policy")).toContain("style-src");

  const redirect = await ask("/new");
  expect(redirect.status).toBeGreaterThanOrEqual(300);
  expect(redirect.status).toBeLessThan(400);
  expect(redirect.headers.get("location")).toBeTruthy();
  expect(lacks(redirect)).toEqual([]);

  const text = await ask("/robots.txt", { headers: { accept: "text/plain" } });
  expect(text.status).toBe(200);
  expect(text.headers.get("content-type")).toStartWith("text/plain");
  expect(lacks(text)).toEqual([]);
});

test("the internal listener floors even the refusal of a caller with no boot secret", async () => {
  const at = app.hookAddress.current;
  const res = at.startsWith("tcp:")
    ? await fetch(`http://${at.slice("tcp:".length)}/internal/hook`, { method: "POST" })
    : await fetch("http://localhost/internal/hook", { method: "POST", unix: at });
  expect(res.status).toBe(403);
  expect(lacks(res)).toEqual([]);
});

test("the beat door floors its refusals", async () => {
  const door = openBeatDoor(app);
  try {
    const res = await fetch(`http://127.0.0.1:${door.port}/nowhere`);
    expect(res.status).toBe(404);
    expect(lacks(res)).toEqual([]);
  } finally {
    door.close();
  }
});

test("securityFloor over an html response or a redirect lays the floor and keeps a page's own policy", () => {
  const html = securityFloor(
    new Response("<!doctype html>", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'" } }),
  );
  expect(lacks(html)).toEqual([]);
  expect(html.headers.get("content-security-policy")).toBe("default-src 'self'");
  const moved = securityFloor(new Response(null, { status: 303, headers: { location: "/login" } }));
  expect(lacks(moved)).toEqual([]);
  expect(moved.headers.get("content-security-policy")).toContain("default-src 'none'");
});
