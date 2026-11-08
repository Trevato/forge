import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missed } from "../src/perf/load_verdict.ts";
import { PRODUCTION_HOST, refuseProduction } from "../src/perf/production_guard.ts";

// The person's release run (#9596): one command, both passes, both files, each with its verdict.
const oid = "b".repeat(40);
const page = `<a href="/o/r/blob/${oid}/f.txt">f</a><a href="/o/r/tree/${oid}/d">d</a>`;

/** Runs scripts/release-load.ts against a fake forge answering after `delayMs`; returns both files and what each pass's request carried. */
const release = async (delayMs: number) => {
  const dir = await mkdtemp(join(tmpdir(), "forge-release-load-"));
  const cookies = { bypass: 0, none: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (/\/(blob|tree|raw)\/[0-9a-f]{40}/.test(new URL(req.url).pathname)) {
        req.headers.get("cookie") === "forge_load=bypass" ? cookies.bypass++ : cookies.none++;
        if (delayMs > 0) await Bun.sleep(delayMs);
      }
      return new Response(page, { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const p = Bun.spawn(
      ["bun", "scripts/release-load.ts", "9.9.9", "--url", `http://127.0.0.1:${server.port}`, "--repo", "o/r", "--seconds", "1", "--warm", "1", "--results", dir],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, , err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const read = async (f: string) => JSON.parse(await readFile(join(dir, f), "utf8"));
    return { code, err, cookies, edge: await read("9.9.9.json"), bypass: await read("9.9.9.bypass.json") };
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
};

test("a forge that keeps up gets both files at 500/s, each with its warm-up and \"target met\"", async () => {
  const r = await release(0);
  expect(r.code).toBe(0);
  for (const [file, cache] of [[r.edge, "edge"], [r.bypass, "bypass"]] as const) {
    expect(file.version).toBe("9.9.9");
    expect(file.cache).toBe(cache);
    expect(file.asked).toBe(500);
    expect(file.refused).toBe(0);
    expect(file.servedPerSecond).toBeGreaterThanOrEqual(475);
    expect(file.p95).toBeLessThan(100);
    expect(typeof file.p50).toBe("number");
    expect(file.warm.seconds).toBe(1);
    expect(file.warm.served).toBeGreaterThan(0);
    expect(file.target).toEqual({ rate: 500, refused: 0, p95UnderMs: 100 });
    expect(file.verdict).toBe("target met");
  }
  // The edge pass carries no cookie; every request of the bypass pass carries the one the edge must pass on.
  expect(r.cookies.none).toBeGreaterThan(0);
  expect(r.cookies.bypass).toBeGreaterThan(0);
  expect(r.err).toContain("9.9.9.json: target met");
  expect(r.err).toContain("9.9.9.bypass.json: target met");
}, 30_000);

test("a forge answering in 150 ms gets both files saying how far p95 missed", async () => {
  const r = await release(150);
  // Missing the target is written down, not a failed run: only a fall from a kept result exits 1.
  expect(r.code).toBe(0);
  for (const file of [r.edge, r.bypass]) {
    expect(file.p95).toBeGreaterThanOrEqual(150);
    expect(file.verdict).toBe(`p95 ${file.p95} ms, ${Math.round((file.p95 - 100) * 10) / 10} ms over the 100 ms target`);
  }
  expect(r.err).toContain("9.9.9.bypass.json: p95 ");
}, 30_000);

test("the verdict says how far each part of the goal was missed", () => {
  const r = (o: object) => ({ version: "1", asked: 500, seconds: 20, served: 10_000, refused: 0, servedPerSecond: 500, p50: 3, p95: 40, ...o });
  expect(missed(r({}))).toBeUndefined();
  expect(missed(r({ asked: 100 }))).toBe("asked 100/s, 400/s under the 500/s target");
  expect(missed(r({ servedPerSecond: 400 }))).toBe("served 400/s, 100/s under the 500/s target");
  expect(missed(r({ servedPerSecond: 476 }))).toBeUndefined();
  expect(missed(r({ refused: 12, served: 9_988 }))).toBe("12 refused of 10000");
  expect(missed(r({ p95: 131.4 }))).toBe("p95 131.4 ms, 31.4 ms over the 100 ms target");
});

test("production is refused by name, by any name under it and by its address; a copy is not", async () => {
  let asked = 0;
  const resolve = async () => (asked++, ["203.0.113.7", "2001:db8::7"]);
  for (const url of [`https://${PRODUCTION_HOST}`, `https://FORGE.open-platform.sh./`, `http://${PRODUCTION_HOST}:8080/x`, `https://edge.${PRODUCTION_HOST}`, "https://203.0.113.7", "http://[2001:db8::7]:80"])
    expect(await refuseProduction(url, resolve)).toContain("production");
  expect(await refuseProduction("https://copy.example", resolve)).toBeUndefined();
  expect(await refuseProduction("https://copy--forge.open-platform.sh", resolve)).toBeUndefined();
  expect(await refuseProduction("http://127.0.0.1:9999", resolve)).toBeUndefined();
  expect(await refuseProduction("https://198.51.100.1", resolve)).toBeUndefined();
  // A name is decided without asking a resolver; only an address literal needs production's addresses.
  expect(asked).toBe(3);
  expect(await refuseProduction("https://198.51.100.1", async () => Promise.reject(new Error("no dns")))).toContain("could not be resolved");
  expect(await refuseProduction("ftp://copy.example", resolve)).toContain("http or https");
  expect(await refuseProduction("not a url", resolve)).toContain("not a URL");
});

test("release-load and bench/load.ts refuse a production --url before any request, writing nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-release-load-"));
  try {
    for (const cmd of [
      ["bun", "scripts/release-load.ts", "9.9.9", "--url", `https://${PRODUCTION_HOST}`, "--repo", "trevato/forge", "--results", dir],
      ["bun", "bench/load.ts", "--url", `https://${PRODUCTION_HOST}/`, "--repo", "trevato/forge", "--out", join(dir, "x.json")],
    ]) {
      // A proxy that is not there: were a request sent, it would fail as a connection error, not this refusal.
      const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" } });
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      expect(code).toBe(2);
      expect(err).toContain(`refused: --url https://${PRODUCTION_HOST} is production`);
    }
    expect(existsSync(join(dir, "9.9.9.json")) || existsSync(join(dir, "9.9.9.bypass.json")) || existsSync(join(dir, "x.json"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
