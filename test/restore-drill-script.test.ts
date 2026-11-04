/**
 * `scripts/restore-drill.ts` (#9046) run end to end: a tiny snapshot taken
 * here, served from a stub bucket that speaks the S3 the store asks for,
 * restored with only the card's variables, booted, and its public counts
 * set beside a stub production's. Matching counts are green; the
 * arguments and the comparison are checked as plain data.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { compareLines, parseArgs, PRODUCTION } from "../scripts/restore-drill.ts";
import { publicCounts } from "../src/snapshot/public_counts.ts";

const PASS = "correct horse battery staple";
const BUCKET = "drill";
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const xml = (s: string): string => s.replace(/[&<>]/g, (c) => ESC[c]!);

let root: string;
let app: App;
let bucket: ReturnType<typeof Bun.serve>;
let production: ReturnType<typeof Bun.serve>;

function keysUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) keysUnder(path, out);
    else out.push(path);
  }
  return out;
}

/** Path-style S3 over a directory: HEAD and GET of a key, and ListObjectsV2 with a delimiter. */
function stubBucket(dir: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      if (path === `/${BUCKET}` || path === `/${BUCKET}/`) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const keys = keysUnder(dir).map((p) => relative(dir, p)).filter((k) => k.startsWith(prefix)).sort();
        const contents: string[] = [];
        const prefixes = new Set<string>();
        for (const key of keys) {
          const cut = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
          if (cut >= 0) prefixes.add(key.slice(0, cut + 1));
          else contents.push(key);
        }
        const body =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${xml(prefix)}</Prefix>` +
          `<KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>` +
          contents.map((k) => `<Contents><Key>${xml(k)}</Key><Size>${statSync(join(dir, k)).size}</Size></Contents>`).join("") +
          [...prefixes].map((p) => `<CommonPrefixes><Prefix>${xml(p)}</Prefix></CommonPrefixes>`).join("") +
          `</ListBucketResult>`;
        return new Response(body, { headers: { "content-type": "application/xml" } });
      }
      const key = path.slice(`/${BUCKET}/`.length);
      if (!path.startsWith(`/${BUCKET}/`) || key.split("/").includes("..")) return new Response(null, { status: 400 });
      const file = join(dir, key);
      if (!existsSync(file)) return new Response(null, { status: 404 });
      return new Response(req.method === "HEAD" ? null : readFileSync(file), {
        headers: { "content-length": String(statSync(file).size) },
      });
    },
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-restore-drill-"));
  app = createApp({ dataDir: join(root, "live"), port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  for (const [name, visibility] of [["notes", "public"], ["diary", "private"]] as const) {
    const repo = await createRepo(app, u.value, { name, visibility });
    if (!repo.ok) throw new Error(String(repo.error));
    const c = await commitToBranch(app, u.value, repo.value, {
      message: "first",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  }
  await takeSnapshot(
    { db: app.db, dataDir: app.config.dataDir, reposRoot: app.reposRoot, version: "t", passphrase: PASS },
    dirStore(join(root, "store")),
    new Date("2026-11-01T08:00:00Z"),
  );
  bucket = stubBucket(join(root, "store"));
  // Production as anyone sees it: the one public repository, no apps.
  production = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/repos") return Response.json({ items: [{ id: 1 }], next_cursor: null });
      if (path === "/api/v1/apps") return Response.json({ items: [], next_cursor: null });
      return new Response(null, { status: 404 });
    },
  });
});

afterAll(async () => {
  app.close();
  bucket.stop(true);
  production.stop(true);
  await rm(root, { recursive: true, force: true });
});

test("the drill restores from the bucket alone, boots, and matches production's public counts", async () => {
  const data = join(root, "box");
  const run = Bun.spawn(
    [process.execPath, "scripts/restore-drill.ts", data, "--production", `http://127.0.0.1:${production.port}`],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: root,
        S3_ENDPOINT: `http://127.0.0.1:${bucket.port}`,
        S3_BUCKET: BUCKET,
        S3_ACCESS_KEY: "stub",
        S3_SECRET_KEY: "stub",
        S3_REGION: "us-east-1",
        FORGE_SNAPSHOT_PASSPHRASE: PASS,
        ...(process.env["FORGE_TEST_SOCKET"] ? { FORGE_TEST_SOCKET: process.env["FORGE_TEST_SOCKET"] } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect(err + out).toContain("restore-drill: 2026-11-01T08-00-00Z from 127.0.0.1:");
  expect(out).toContain("and 2 repositories");
  expect(out).toMatch(/booted: \/ answered [23]\d\d/);
  expect(out).toContain("repositories: restored 1, production 1");
  expect(out).toContain("apps: restored 0, production 0");
  expect(out).toContain("restore-drill: green");
  expect(code).toBe(0);
  expect(existsSync(join(data, "forge.db"))).toBe(true);
}, 120_000);

test("the arguments: a data directory, production by default, never production's own directory", () => {
  expect(parseArgs(["/var/lib/forge"])).toEqual({ dataDir: "/var/lib/forge", production: PRODUCTION });
  expect(parseArgs(["/data"])).toContain("production's data directory");
  expect(parseArgs([])).toContain("usage");
  expect(parseArgs(["/x", "--production", "http://forge.example"])).toContain("https");
  expect(parseArgs(["/x", "--production", "not a url"])).toContain("URL");
});

test("a count that differs is named", () => {
  const same = compareLines({ repositories: 3, apps: 1 }, { repositories: 3, apps: 1 });
  expect(same.differ).toEqual([]);
  const off = compareLines({ repositories: 3, apps: 1 }, { repositories: 4, apps: 1 });
  expect(off.differ).toEqual(["repositories"]);
  expect(off.lines[0]).toBe("repositories: restored 3, production 4  DIFFERS");
});

test("public counts follow the cursor and leave out the preview admin's seeded rows", async () => {
  const pages: Record<string, unknown> = {
    "/api/v1/repos?limit=100": { items: [{ ownerName: "alice" }, { ownerName: "preview-admin" }], next_cursor: "b" },
    "/api/v1/repos?limit=100&cursor=b": { items: [{ ownerName: "bob" }], next_cursor: null },
    "/api/v1/apps?limit=100": { items: [{ repo: { owner: "alice" } }, { repo: { owner: "preview-admin" } }], next_cursor: null },
  };
  const fetcher = async (url: string): Promise<Response> => {
    const u = new URL(url);
    const body = pages[u.pathname + u.search];
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  };
  expect(await publicCounts("http://forge.test", { fetcher })).toEqual({ repositories: 3, apps: 2 });
  expect(await publicCounts("http://forge.test", { fetcher, except: "preview-admin" })).toEqual({ repositories: 2, apps: 1 });
});
