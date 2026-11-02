/**
 * `forge asks --ship/--close/--dismiss <n…>` against a fake API: the numbers
 * map to the ids of the read just made, nothing is applied without a yes,
 * and a refusal prints the API's words with the right exit code.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createOut } from "../src/cli/out.ts";
import { parseArgs } from "../src/cli/args.ts";
import { asks, EXIT, type Confirm } from "../src/cli/main.ts";
import { parseWish } from "../src/cli/decide.ts";

let ids = ["look:1", "parked:2", "pr:3"];
let server: ReturnType<typeof Bun.serve>;
let base = "";
let bulkReply: (body: any) => Response;
const posts: any[] = [];
const undos: string[] = [];
let reads = 0;

const plan = (body: any) =>
  Response.json({
    preview: true,
    rows: body.items.map((i: string) => ({
      label: `alice/shop#${i}`,
      outcome: "change",
      reason: "",
      before: "open",
      after: "closed",
    })),
    skipped: [],
  });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/asks") {
        reads++;
        return Response.json({
          rows: ids.map((id) => ({ id, kind: "look", repo: "alice/shop", line: `row ${id}`, link: "/x" })),
          forge: ["The check lane is stuck."],
        });
      }
      if (url.pathname === "/api/v1/asks/bulk") {
        const body = await req.json();
        posts.push(body);
        return bulkReply(body);
      }
      const undo = /^\/api\/v1\/asks\/bulk\/([^/]+)\/undo$/.exec(url.pathname);
      if (undo && req.method === "POST") {
        undos.push(undo[1]!);
        return undo[1] === "gone"
          ? Response.json({ error: "not_found", message: "no such operation" }, { status: 404 })
          : Response.json({ id: "u1", rows: [{ label: "alice/shop#1", outcome: "ok", before: "closed", after: "open" }], skipped: [] }, { status: 201 });
      }
      return Response.json({ error: "not_found", message: "no" }, { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  process.env["FORGE_URL"] = base;
  process.env["FORGE_TOKEN"] = "tok";
  process.env["FORGE_KEYCHAIN"] = "0";
  process.env["NO_COLOR"] = "1";
});
afterAll(() => server.stop(true));
beforeEach(() => {
  posts.length = 0;
  undos.length = 0;
  reads = 0;
  ids = ["look:1", "parked:2", "pr:3"];
  bulkReply = (body) =>
    body.preview === false
      ? Response.json({ preview: false, id: "op9", rows: body.items.map((i: string) => ({ label: i, outcome: "ok", before: "open", after: "closed" })), skipped: [] }, { status: 201 })
      : plan(body);
});

async function run(argv: string[], confirm: Confirm) {
  let out = "";
  let err = "";
  const o = createOut((t) => (out += t), (t) => (err += t));
  const code = await asks(o, parseArgs(["asks", ...argv], { values: ["repo", "reason"] }), argv, confirm);
  return { code, out, err };
}

test("the list numbers its lines", async () => {
  const r = await run([], async () => undefined);
  expect(r.out.split("\n")[0]).toMatch(/^1 {2}look/);
  expect(r.out.split("\n")[3]).toMatch(/^4 {2}forge/);
});

test("the preview names the right items; no yes, no apply", async () => {
  const r = await run(["--ship", "1", "3"], async () => false);
  expect(posts).toEqual([{ action: "ship", items: ["look:1", "pr:3"], preview: true }]);
  expect(r.out).toContain("Would ship:");
  expect(r.out).toContain("Nothing applied.");
  expect(r.code).toBe(EXIT.ok);
});

test("a yes applies once and prints the receipt and the undo line", async () => {
  let asked = "";
  const r = await run(["--close", "2", "--reason", "not now"], async (q) => ((asked = q), true));
  expect(asked).toBe("Apply? [y/N] ");
  expect(posts.map((p) => p.preview)).toEqual([true, false]);
  expect(posts[1]).toEqual({ action: "close", items: ["parked:2"], reason: "not now", preview: false });
  expect(r.out).toContain("Receipt op9");
  expect(r.out).toContain(`Undo: forge asks --undo op9`);
});

test("--yes skips the question", async () => {
  const r = await run(["--dismiss", "1", "--yes"], async () => {
    throw new Error("asked");
  });
  expect(posts.map((p) => p.preview)).toEqual([true, false]);
  expect(r.code).toBe(EXIT.ok);
});

test("no terminal and no --yes refuses with exit 2, applying nothing", async () => {
  const r = await run(["--dismiss", "1"], async () => undefined);
  expect(r.code).toBe(EXIT.usage);
  expect(r.err).toContain("--yes");
  expect(posts.map((p) => p.preview)).toEqual([true]);
});

test("a number not on the list is refused before any request, named", async () => {
  for (const bad of ["9", "0", "x", "1.5"]) {
    const r = await run(["--ship", "1", bad], async () => true);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain(`no ask is numbered ${bad}`);
  }
  const forgeNeed = await run(["--ship", "4"], async () => true);
  expect(forgeNeed.err).toContain("forge's own need");
  expect(posts).toHaveLength(0);
});

test("numbers come from a fresh read each run", async () => {
  await run(["--ship", "1", "--yes"], async () => true);
  ids = ["other:7", "look:1"];
  await run(["--ship", "1", "--yes"], async () => true);
  expect(posts.map((p) => p.items[0])).toEqual(["look:1", "look:1", "other:7", "other:7"]);
  expect(reads).toBe(2);
});

test("a refusal prints the API's words and exits 1", async () => {
  bulkReply = () => Response.json({ error: "bad_action", message: "only close takes a reason" }, { status: 422 });
  const r = await run(["--ship", "1"], async () => true);
  expect(r.code).toBe(EXIT.failed);
  expect(r.err).toContain("only close takes a reason");
  bulkReply = () => Response.json({ error: "unauthorized", message: "sign in" }, { status: 401 });
  expect((await run(["--ship", "1"], async () => true)).code).toBe(EXIT.notConfigured);
});

test("parseWish reads groups and refuses mixed or bare lines", () => {
  expect(parseWish(["--ship", "1", "3", "--yes"])).toEqual({ action: "ship", numbers: ["1", "3"], reason: undefined });
  expect(parseWish(["--repo", "a/b"])).toBeUndefined();
  expect(parseWish(["--ship", "1", "--close", "2"])).toContain("one decision");
  expect(parseWish(["--ship"])).toContain("numbers");
  expect(parseWish(["--ship", "1", "--reason", "x"])).toContain("--close");
});

test("--undo posts the receipt's undo, once, with no question", async () => {
  const r = await run(["--undo", "op9"], async () => {
    throw new Error("asked");
  });
  expect(undos).toEqual(["op9"]);
  expect(posts).toHaveLength(0);
  expect(r.code).toBe(EXIT.ok);
  expect(r.out).toContain("alice/shop#1");
  const gone = await run(["--undo", "gone"], async () => true);
  expect(gone.code).toBe(EXIT.failed);
  expect(gone.err).toContain("no such operation");
  expect(parseWish(["--undo", "op9", "--ship", "1"])).toContain("stands alone");
  expect(parseWish(["--undo"])).toContain("receipt");
});

test("more than 100 numbers are refused before any request", async () => {
  const many = Array.from({ length: 101 }, (_, i) => String(i + 1));
  const r = await run(["--dismiss", ...many], async () => true);
  expect(r.code).toBe(EXIT.usage);
  expect(r.err).toContain("at most 100");
  expect(posts).toHaveLength(0);
  expect(parseWish(["--dismiss", ...many.slice(0, 100)])).toMatchObject({ action: "dismiss" });
});

test("the parser pins loose words and a bare --reason", () => {
  expect(parseWish(["--ship", "1", "--repo", "a/b", "2"])).toContain('unexpected "2"');
  expect(parseWish(["--ship", "1", "--yes", "2"])).toContain('unexpected "2"');
  expect(parseWish(["--ship", "1", "--repo", "a/b"])).toMatchObject({ numbers: ["1"] });
  expect(parseWish(["--close", "1", "--reason"])).toContain("needs words");
  expect(parseWish(["--close", "1", "--reason", "--yes"])).toContain("needs words");
  expect(parseWish(["--close", "1", "--reason", "  "])).toContain("needs words");
  expect(parseWish(["--close", "1", "--reason=because"])).toMatchObject({ reason: "because" });
  expect(parseWish(["stray"])).toContain('unexpected "stray"');
});
