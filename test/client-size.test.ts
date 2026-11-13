/**
 * Each first page's client JavaScript and CSS, gzip bytes, stay under the
 * ceiling in docs/design/size-budget.json (#12018). Same pages as the
 * page-load budget. FORGE_SIZE_WRITE=1 rewrites the file with today's numbers
 * plus headroom (2 %, up to the next 256 B: `ceilingFor`, #12040); raising one
 * needs a note in the pull. Each page is rendered twice and its counted inline
 * code must be identical, so the verdict is the same on every run.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ceilingFor, ceilingsFor, clientSize, inlineDrift, sizeFindings, SIZE_WRITE_COMMAND, type Ceilings } from "../src/measure/client_size.ts";
import { PAGE_BUDGETS, pagePath } from "../src/perf/page_budget.ts";
import { mintClaim } from "../src/spawn/claim.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const FILE = "docs/design/size-budget.json";
let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-size-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  promote(app.db, u.value);
  proveAll(app);
  for (const name of ["forge", "notes"]) {
    const made = await createRepo(app, u.value, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }
  const notes = getRepo(app.db, "alice", "notes")!;
  const files = await commitToBranch(app, u.value, notes, {
    message: "an app",
    files: [
      { path: "README.md", content: "# notes\n" },
      { path: "forge.json", content: JSON.stringify({ run: "bun run main.ts" }) },
      { path: "main.ts", content: "Bun.serve({ fetch: () => new Response('ok') });\n" },
    ],
  });
  if (!files.ok) throw new Error(JSON.stringify(files.error));
  const kin = createOrg(app.db, "kin", u.value.id);
  if (!kin.ok) throw new Error(kin.error);
  await Bun.write(join(root, "parent.json"), JSON.stringify({ org: "kin" }));
  mintClaim(app.db, kin.value.id);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST", headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  if (!cookie) throw new Error("alice could not sign in");
}, 60_000);

afterAll(() => {
  servers?.stop();
  app?.close();
  rmSync(root, { recursive: true, force: true });
});

async function render(b: (typeof PAGE_BUDGETS)[number]): Promise<string> {
  const res = await fetch(`${servers.url}${pagePath(b, "alice", "notes")}`, {
    headers: b.signedOut ? { "accept-encoding": "identity" } : { cookie, "accept-encoding": "identity" },
  });
  if (res.status !== 200) throw new Error(`${b.pattern} answered ${res.status}`);
  return res.text();
}

async function measure(): Promise<{ sizes: Ceilings; drift: string[] }> {
  const sizes: Ceilings = {};
  const drift: string[] = [];
  for (const b of PAGE_BUDGETS) {
    const html = await render(b);
    drift.push(...inlineDrift(`${b.pattern} (${b.page})`, html, await render(b)));
    sizes[b.pattern] = await clientSize(html, async (path) => {
      const asset = await fetch(`${servers.url}${path}`, { headers: { "accept-encoding": "identity" }, redirect: "follow" });
      if (asset.status !== 200) throw new Error(`${path} answered ${asset.status}`);
      return asset.text();
    });
  }
  return { sizes, drift };
}

test("no first page's client JavaScript or CSS passes its ceiling, and each page measures the same twice", async () => {
  const { sizes, drift } = await measure();
  expect(drift).toEqual([]);
  if (process.env["FORGE_SIZE_WRITE"] === "1") {
    writeFileSync(FILE, `${JSON.stringify(ceilingsFor(sizes), null, 2)}\n`);
    return;
  }
  const ceilings = JSON.parse(readFileSync(FILE, "utf8")) as Ceilings;
  const findings = PAGE_BUDGETS.flatMap((b) => sizeFindings(`${b.pattern} (${b.page})`, sizes[b.pattern]!, ceilings[b.pattern]));
  console.log(`client bytes, gzip:\n${PAGE_BUDGETS.map((b) => `${b.pattern}\tjs ${sizes[b.pattern]!.js}\tcss ${sizes[b.pattern]!.css}`).join("\n")}`);
  expect(findings).toEqual([]);
}, 60_000);

test("the ceiling file names exactly the budgeted pages", () => {
  const ceilings = JSON.parse(readFileSync(FILE, "utf8")) as Ceilings;
  expect(Object.keys(ceilings).sort()).toEqual(PAGE_BUDGETS.map((b) => b.pattern).sort());
});

test("a page over its ceiling is named with the bytes over and the command that raises it", () => {
  expect(sizeFindings("/explore (explore)", { js: 1500, css: 900 }, { js: 1000, css: 900 })).toEqual([
    "/explore (explore): js 1500 B gzip, 500 B over its ceiling of 1000 B; raise it in this pull with `FORGE_SIZE_WRITE=1 bun test test/client-size.test.ts` and say why",
  ]);
  expect(SIZE_WRITE_COMMAND).toBe("FORGE_SIZE_WRITE=1 bun test test/client-size.test.ts");
  const none = sizeFindings("/x (x)", { js: 1, css: 1 }, undefined)[0]!;
  expect(none).toContain("no ceiling");
  expect(none).toContain(SIZE_WRITE_COMMAND);
});

test("a written ceiling is the measure plus 2 %, rounded up to the next 256 B", () => {
  // by hand: 1000 × 1.02 = 1020 → 1024; 1004 × 1.02 = 1024.08 → 1280;
  // 0 → 0; 251 × 1.02 = 256.02 → 512; 250 × 1.02 = 255 → 256;
  // 20824 × 1.02 = 21240.48 → 21248 (83 × 256).
  expect(ceilingFor(1000)).toBe(1024);
  expect(ceilingFor(1004)).toBe(1280);
  expect(ceilingFor(0)).toBe(0);
  expect(ceilingFor(250)).toBe(256);
  expect(ceilingFor(251)).toBe(512);
  expect(ceilingFor(20824)).toBe(21248);
  expect(() => ceilingFor(-1)).toThrow();
  expect(() => ceilingFor(1.5)).toThrow();
  expect(ceilingsFor({ "/": { js: 1000, css: 1004 } })).toEqual({ "/": { js: 1024, css: 1280 } });
  for (let n = 0; n < 50_000; n += 7) {
    const c = ceilingFor(n);
    expect(c % 256).toBe(0);
    expect(c).toBeGreaterThanOrEqual(n * 1.02);
    expect(c - 256).toBeLessThan(n * 1.02);
  }
});

test("two renders that differ in counted inline code are named by page and block; data blocks may differ", () => {
  const page = (nonce: string, t: string) =>
    `<script nonce="${nonce}">let a=1;</script><script type="application/json">{"t":"${t}"}</script><style>b{c:d}</style><script>let t="${t}";</script>`;
  expect(inlineDrift("/ (home)", page("n1", "x"), page("n2", "x"))).toEqual([]);
  const d = inlineDrift("/ (home)", page("n1", "10:00"), page("n1", "10:01"));
  expect(d).toHaveLength(1);
  expect(d[0]).toStartWith("/ (home): inline script #2 differs");
  expect(inlineDrift("/ (home)", "<style>a{}</style>", "")).toEqual(["/ (home): 1 counted inline blocks on one render, 0 on the next"]);
});

test("the count is gzip of linked and inline code, and leaves data blocks out", async () => {
  const html = `<link rel="stylesheet" href="/assets/a.css"><script src="/assets/a.js" defer></script>
    <script nonce="n">let a=1;</script><script type="application/json">{"a":1}</script><style>b{c:d}</style>`;
  const gz = (s: string): number => Bun.gzipSync(new TextEncoder().encode(s)).length;
  const size = await clientSize(html, async (p) => (p.endsWith(".js") ? "x".repeat(1000) : "y{z:1}".repeat(100)));
  expect(size).toEqual({ js: gz("x".repeat(1000)) + gz("let a=1;"), css: gz("y{z:1}".repeat(100)) + gz("b{c:d}") });
});
