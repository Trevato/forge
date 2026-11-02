import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPlan } from "../src/cli/api.ts";
import { EXIT, main } from "../src/cli/main.ts";
import { MAP_GROUP_LINES, mapLines } from "../src/cli/plan.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
const env = { url: process.env["FORGE_URL"], token: process.env["FORGE_TOKEN"] };
afterEach(() => {
  server?.stop(true);
  for (const [k, v] of [["FORGE_URL", env.url], ["FORGE_TOKEN", env.token]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const seen: string[] = [];
function fake(body: unknown): void {
  seen.length = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      if (url.pathname === "/api/v1/repos/acme/app/map") return Response.json(body);
      if (url.pathname === "/api/v1/repos/acme/secret/map")
        return Response.json({ error: "forbidden", message: "you cannot read acme/secret" }, { status: 403 });
      return Response.json({ error: "not_found", message: "no repository acme/gone" }, { status: 404 });
    },
  });
  process.env["FORGE_URL"] = `http://127.0.0.1:${server.port}`;
  process.env["FORGE_TOKEN"] = "t";
}

async function run(argv: string[], cwd?: string) {
  const lines: string[] = [];
  const errs: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const werr = process.stderr.write.bind(process.stderr);
  const prev = process.cwd();
  if (cwd) process.chdir(cwd);
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as never;
  process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as never;
  try {
    const code = await main(argv);
    return { code, out: lines.join("").split("\n"), err: errs.join("") };
  } finally {
    process.stdout.write = write;
    process.stderr.write = werr;
    process.chdir(prev);
  }
}

const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  state: "open",
  assignee: null,
  pillar: null,
  ...extra,
});

/**
 * #1 is built by scout; #2 is ready under Reach; #3 is ready but taken, so
 * not startable; #4 waits on #1 and #2; #5 waits on #4; #6 is closed and
 * its edge to #5 does not count.
 */
const map = {
  repo: { owner: "acme", name: "app" },
  ready: [
    { ...issue(1, "Build the gauge", { assignee: "scout", pillar: "Reach" }), holdsUp: 1 },
    { ...issue(2, "Draw the dial", { pillar: "Reach" }), holdsUp: 1 },
    { ...issue(3, "Taken already", { assignee: "mason" }), holdsUp: 0 },
    { ...issue(7, "No pillar here"), holdsUp: 0 },
  ],
  startable: [2, 7],
  working: [1],
  issues: [
    issue(1, "Build the gauge", { assignee: "scout", pillar: "Reach" }),
    issue(2, "Draw the dial", { pillar: "Reach" }),
    issue(3, "Taken already", { assignee: "mason" }),
    issue(4, "Wire the dial to the gauge"),
    issue(5, "Ship it"),
    { ...issue(6, "Old"), state: "closed" },
    issue(7, "No pillar here"),
  ],
  edges: [
    { issue: 4, blockedBy: 2 },
    { issue: 4, blockedBy: 1 },
    { issue: 5, blockedBy: 4 },
    { issue: 5, blockedBy: 6 },
  ],
};

test("prints Working, Ready and Waiting, each headed with its count", async () => {
  fake(map);
  const r = await run(["map", "--repo", "acme/app"]);
  expect(r.code).toBe(EXIT.ok);
  expect(seen).toEqual(["/api/v1/repos/acme/app/map"]);
  expect(r.out.filter(Boolean)).toEqual([
    "Working (1)",
    "  #1 Build the gauge — scout",
    "Ready (2)",
    "  #2 Draw the dial — Reach",
    "  #7 No pillar here — no pillar",
    "Waiting (2)",
    "  #4 Wire the dial to the gauge — waits on #1, #2",
    "  #5 Ship it — waits on #4",
  ]);
});

test("each group stops at 15 lines and says how many more", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    number: 100 + i,
    title: `Issue ${i}`,
    assignee: null,
    pillar: null,
    waitsOn: [1],
  }));
  const lines = mapLines({ working: [], ready: many, waiting: many.slice(0, 15) }, 80);
  const ready = lines.slice(lines.indexOf("Ready (20)") + 1, lines.indexOf("Waiting (15)") - 1);
  expect(ready).toHaveLength(MAP_GROUP_LINES + 1);
  expect(MAP_GROUP_LINES).toBe(15);
  expect(ready.at(-1)).toBe("  … 5 more");
  expect(ready[14]).toBe("  #114 Issue 14 — no pillar");
  // Exactly fifteen: no "more" line.
  expect(lines.slice(lines.indexOf("Waiting (15)") + 1)).toHaveLength(15);
  expect(lines.slice(0, 4)).toEqual(["Working (0)", "  nothing being built", "", "Ready (20)"]);
});

test("titles are cut so no line is wider than the terminal", () => {
  const long = { number: 9, title: "x".repeat(200), assignee: "scout", pillar: null, waitsOn: [] };
  const [, line] = mapLines({ working: [long], ready: [], waiting: [] }, 40);
  expect(line!.length).toBeLessThanOrEqual(39);
  expect(line).toEndWith("… — scout");
});

test("--json prints the answer unchanged", async () => {
  fake(map);
  const r = await run(["map", "--repo", "acme/app", "--json"]);
  expect(r.code).toBe(EXIT.ok);
  expect(JSON.parse(r.out[0]!)).toEqual(map);
});

test("an unknown repository prints the API's words and the matching exit", async () => {
  fake(map);
  const gone = await run(["map", "--repo", "acme/gone"]);
  expect(gone.code).toBe(EXIT.failed);
  expect(gone.err).toContain("no repository acme/gone");
  const secret = await run(["map", "--repo", "acme/secret"]);
  expect(secret.code).toBe(EXIT.refused);
  expect(secret.err).toContain("you cannot read acme/secret");
});

test("a bad --repo, or a folder that is no clone, exits 2 before any request", async () => {
  fake(map);
  expect((await run(["map", "--repo", "nope"])).code).toBe(EXIT.usage);
  const dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "map-"));
  expect((await run(["map"], dir)).code).toBe(EXIT.usage);
  expect(seen).toEqual([]);
});

test("a map with no startable list falls back to the unassigned ready", () => {
  const { startable: _, ...older } = map;
  expect(toPlan(older).ready.map((i) => i.number)).toEqual([2, 7]);
  expect(toPlan(null)).toEqual({ raw: null, working: [], ready: [], waiting: [] });
});

test("a blocker that is closed, or only in edges, holds nothing; Working wins over Waiting", () => {
  const plan = toPlan({
    issues: [
      { number: 1, title: "Build it", state: "open", assignee: "torque" },
      { number: 2, title: "Old blocker", state: "closed" },
      { number: 3, title: "Waits on a gone one", state: "open" },
      { number: 4, title: "Waits for real", state: "open", assignee: "torque" },
      { number: 5, title: "Still open", state: "open" },
    ],
    edges: [
      { issue: 1, blockedBy: 2 },
      { issue: 3, blockedBy: 99 },
      { issue: 4, blockedBy: 5 },
    ],
    working: [1, 4],
    ready: [],
    startable: [],
  });
  expect(plan.working.map((i) => [i.number, i.waitsOn])).toEqual([[1, []], [4, [5]]]);
  expect(plan.waiting).toEqual([]);
});

test("a title, assignee or pillar with terminal escapes prints inert", () => {
  const esc = "\x1b]0;owned\x07\x1b[2J";
  const row = { number: 1, title: `Fix ${esc}it`, assignee: `eve${esc}`, pillar: `P${esc}`, waitsOn: [2] };
  const lines = mapLines({ working: [row], ready: [row], waiting: [row] }, 200);
  const text = lines.join("\n");
  expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  expect(text).toContain("Fix �]0;owned��[2Jit");
  expect(text).toContain("— eve�");
  expect(text).toContain("— P�");
});

test("a closed issue, or one the map does not list, is not Working", () => {
  const plan = toPlan({
    issues: [
      { number: 1, title: "Built", state: "closed", assignee: "torque" },
      { number: 2, title: "Building", state: "open", assignee: "torque" },
    ],
    edges: [],
    working: [1, 2, 3],
    ready: [],
    startable: [],
  });
  expect(plan.working.map((i) => i.number)).toEqual([2]);
});

test("an empty group says so under its heading", () => {
  expect(mapLines({ working: [], ready: [], waiting: [] }, 80)).toEqual([
    "Working (0)",
    "  nothing being built",
    "",
    "Ready (0)",
    "  nothing ready",
    "",
    "Waiting (0)",
    "  nothing waiting",
  ]);
});

test("help lists map", async () => {
  expect((await run(["help"])).out.join("\n")).toContain("forge map");
});
