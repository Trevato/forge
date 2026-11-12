import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFromRemote } from "../src/cli/folder-repo.ts";
import { EXIT, main } from "../src/cli/main.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
const env = { url: process.env["FORGE_URL"], token: process.env["FORGE_TOKEN"] };
afterEach(() => {
  server?.stop(true);
  for (const [k, v] of [["FORGE_URL", env.url], ["FORGE_TOKEN", env.token]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const seen: string[] = [];
function fake(items: unknown[]): void {
  seen.length = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname + url.search);
      return url.pathname === "/api/v1/repos/acme/app/pulls"
        ? Response.json({ items, next_cursor: null })
        : Response.json({ error: "not_found" }, { status: 404 });
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
    return { code, out: lines.join("").split("\n").filter(Boolean), err: errs.join("") };
  } finally {
    process.stdout.write = write;
    process.stderr.write = werr;
    process.chdir(prev);
  }
}

const items = [
  { number: 12, title: "Add pulls", author: "scout", check: "green", preview: "https://p12.example" },
  { number: 9, title: "Fix it", author: "mason", check: "red", preview: null },
  { number: 7, title: "Wait", author: "atlas", check: "running", preview: null },
  { number: 5, title: "Bare", author: "quill", check: "none", preview: null },
];

test("lists one line per pull with the check and preview", async () => {
  fake(items);
  const r = await run(["pulls", "--repo", "acme/app"]);
  expect(r.code).toBe(EXIT.ok);
  expect(r.out).toHaveLength(4);
  expect(r.out[0]).toMatch(/^#12 +Add pulls +scout +green +https:\/\/p12\.example$/);
  expect(r.out[1]).toMatch(/^ #9 +Fix it +mason +red$/);
  expect(r.out[2]).toMatch(/running$/);
  expect(r.out[3]).toMatch(/quill +none$/);
  expect(seen[0]).toContain("state=open");
});

test("--closed asks for closed pulls and lists them", async () => {
  fake(items.slice(0, 1));
  const r = await run(["pulls", "--repo", "acme/app", "--closed"]);
  expect(r.code).toBe(EXIT.ok);
  expect(seen[0]).toContain("state=closed");
  expect(r.out).toHaveLength(1);
  expect(r.out[0]).toMatch(/^#12 +Add pulls +scout +green/);
});

test("it follows next_cursor, and says so when the list is cut", async () => {
  const many = (from: number) => Array.from({ length: 3 }, (_, i) => ({ number: from - i, title: `p${from - i}`, author: "a", check: "none", preview: null }));
  seen.length = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.search);
      const cursor = url.searchParams.get("cursor");
      if (cursor === null) return Response.json({ items: many(9), next_cursor: 7 });
      return Response.json({ items: many(6), next_cursor: null });
    },
  });
  process.env["FORGE_URL"] = `http://127.0.0.1:${server.port}`;
  process.env["FORGE_TOKEN"] = "t";
  const r = await run(["pulls", "--repo", "acme/app"]);
  expect(r.out).toHaveLength(6);
  expect(seen[1]).toContain("cursor=7");
  expect(r.out.join("\n")).not.toContain("cut");

  seen.length = 0;
  server.stop(true);
  server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ items: many(9), next_cursor: 7 }),
  });
  process.env["FORGE_URL"] = `http://127.0.0.1:${server.port}`;
  const cut = await run(["pulls", "--repo", "acme/app"]);
  expect(cut.out.at(-1)).toMatch(/The list is cut after 60 pulls/);
});

test("--json prints the answer unchanged", async () => {
  fake(items);
  const r = await run(["pulls", "--repo", "acme/app", "--json"]);
  expect(JSON.parse(r.out[0]!)).toEqual({ items, next_cursor: null });
});

test("no pulls says so and exits 0", async () => {
  fake([]);
  expect((await run(["pulls", "--repo", "acme/app"])).out).toEqual(["No open pulls."]);
  expect((await run(["pulls", "--repo", "acme/app"])).code).toBe(0);
});

test("a folder that is not a clone and no --repo exits 2", async () => {
  fake(items);
  const dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "pulls-"));
  const r = await run(["pulls"], dir);
  expect(r.code).toBe(EXIT.usage);
  expect(r.err.trim().split("\n")).toHaveLength(1);
  expect(seen).toEqual([]);
});

test("a bad --repo exits 2; an unknown repo exits 1", async () => {
  fake(items);
  expect((await run(["pulls", "--repo", "nope"])).code).toBe(EXIT.usage);
  expect((await run(["pulls", "--repo", "acme/gone"])).code).toBe(EXIT.failed);
});

test("help lists pulls", async () => {
  expect((await run(["help"])).out.join("\n")).toContain("forge pulls");
});

test("origin remotes map to a repo only on the workbench host", () => {
  const wb = "https://forge.example.com";
  expect(repoFromRemote("https://forge.example.com/acme/app.git\n", wb)).toEqual({ owner: "acme", name: "app" });
  expect(repoFromRemote("git@forge.example.com:acme/app.git", wb)).toEqual({ owner: "acme", name: "app" });
  expect(repoFromRemote("https://github.com/acme/app.git", wb)).toBeUndefined();
  expect(repoFromRemote("garbage", wb)).toBeUndefined();
});
