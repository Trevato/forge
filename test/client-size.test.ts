/**
 * Each first page's client JavaScript and CSS, gzip bytes, stay under the
 * ceiling in docs/design/size-budget.json (#12018). Same pages as the
 * page-load budget. FORGE_SIZE_WRITE=1 rewrites the file with today's numbers
 * (only ever to lower them; raising one needs a note in the pull).
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
import { clientSize, sizeFindings, type Ceilings } from "../src/measure/client_size.ts";
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

async function measure(): Promise<Ceilings> {
  const out: Ceilings = {};
  for (const b of PAGE_BUDGETS) {
    const res = await fetch(`${servers.url}${pagePath(b, "alice", "notes")}`, {
      headers: b.signedOut ? { "accept-encoding": "identity" } : { cookie, "accept-encoding": "identity" },
    });
    if (res.status !== 200) throw new Error(`${b.pattern} answered ${res.status}`);
    out[b.pattern] = await clientSize(await res.text(), async (path) => {
      const asset = await fetch(`${servers.url}${path}`, { headers: { "accept-encoding": "identity" }, redirect: "follow" });
      if (asset.status !== 200) throw new Error(`${path} answered ${asset.status}`);
      return asset.text();
    });
  }
  return out;
}

test("no first page's client JavaScript or CSS passes its ceiling", async () => {
  const sizes = await measure();
  if (process.env["FORGE_SIZE_WRITE"] === "1") {
    writeFileSync(FILE, `${JSON.stringify(sizes, null, 2)}\n`);
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

test("a page over its ceiling is named with the bytes over", () => {
  expect(sizeFindings("/explore (explore)", { js: 1500, css: 900 }, { js: 1000, css: 900 })).toEqual([
    "/explore (explore): js 1500 B gzip, 500 B over its ceiling of 1000 B",
  ]);
  expect(sizeFindings("/x (x)", { js: 1, css: 1 }, undefined)[0]).toContain("no ceiling");
});

test("the count is gzip of linked and inline code, and leaves data blocks out", async () => {
  const html = `<link rel="stylesheet" href="/assets/a.css"><script src="/assets/a.js" defer></script>
    <script nonce="n">let a=1;</script><script type="application/json">{"a":1}</script><style>b{c:d}</style>`;
  const gz = (s: string): number => Bun.gzipSync(new TextEncoder().encode(s)).length;
  const size = await clientSize(html, async (p) => (p.endsWith(".js") ? "x".repeat(1000) : "y{z:1}".repeat(100)));
  expect(size).toEqual({ js: gz("x".repeat(1000)) + gz("let a=1;"), css: gz("y{z:1}".repeat(100)) + gz("b{c:d}") });
});
