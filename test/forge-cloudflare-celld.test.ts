/**
 * The front door, unchanged, on celld: the same worker.js the Cloudflare test
 * drives, served by `celld dev`. Skips, saying why, when celld cannot be
 * fetched or esbuild is not on PATH. Not in the forge.json gate: it needs a
 * GitHub download.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { celld } from "../scripts/celld";

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
}

let skip = "";
let bin = "";
if (!Bun.which("esbuild")) skip = "esbuild is not on PATH (celld bundles with it)";
else
  try {
    bin = await celld();
  } catch (e) {
    skip = `celld cannot be fetched: ${(e as Error).message}`;
  }
if (skip) console.warn(`forge-cloudflare-celld skipped: ${skip}`);

const seen: { method: string; path: string; proto: string | null; body: string }[] = [];
let stub: ReturnType<typeof Bun.serve> | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let dir = "";
let base = "";

async function until(path: string): Promise<Response> {
  const end = Date.now() + 60_000;
  for (;;) {
    try {
      return await fetch(base + path);
    } catch (e) {
      if (Date.now() > end) throw e;
      await Bun.sleep(100);
    }
  }
}

beforeAll(async () => {
  if (skip) return;
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({
        method: req.method,
        path: u.pathname + u.search,
        proto: req.headers.get("x-forwarded-proto"),
        body: await req.text(),
      });
      return new Response("body ok");
    },
  });
  dir = mkdtempSync(join(tmpdir(), "forge-celld-test-"));
  cpSync(join(import.meta.dir, "../infra/forge-cloudflare"), dir, { recursive: true });
  // .dev.vars overrides the config's vars, as for wrangler dev
  await Bun.write(join(dir, ".dev.vars"), `BODY_URL=http://127.0.0.1:${stub.port}\n`);
  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([bin, "dev", dir, "--port", String(port), "--clean", "--no-watch"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}, 30_000);

afterAll(async () => {
  proc?.kill("SIGKILL");
  await proc?.exited;
  stub?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 15_000);

describe.skipIf(!!skip)("forge-cloudflare worker on celld", () => {
  test("a GET and a POST reach the body, told https", async () => {
    const get = await until("/a/b?x=1");
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("body ok");
    const post = await fetch(`${base}/post`, { method: "POST", body: "hello" });
    expect(post.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/a/b?x=1", proto: "https" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/post", proto: "https", body: "hello" });
  }, 70_000);

  test("/healthz is 503 {ok:false} once the body is stopped", async () => {
    stub!.stop(true);
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(false);
  });
});
