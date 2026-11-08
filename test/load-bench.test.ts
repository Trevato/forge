import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bench/load.ts is the release gate: a run slower than 80% of the kept result exits 1.
const oid = "a".repeat(40);
const run = async (kept: object) => {
  const dir = await mkdtemp(join(tmpdir(), "forge-load-"));
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(`<a href="/o/r.x/blob/${oid}/f.txt">f</a>`, { headers: { "content-type": "text/html" } }),
  });
  try {
    const file = join(dir, "last.json");
    await writeFile(file, JSON.stringify(kept));
    const p = Bun.spawn(
      ["bun", "bench/load.ts", "--url", `http://127.0.0.1:${server.port}`, "--repo", "o/r.x", "--rate", "50", "--seconds", "1", "--compare", file],
      { stdout: "pipe", stderr: "pipe" },
    );
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
};
const last = (servedPerSecond: number) => ({ version: "0", asked: 50, seconds: 1, served: servedPerSecond, refused: 0, servedPerSecond, p50: 1, p95: 2 });

test("--compare exits 1 when the served rate fell more than 20%, 0 when it held", async () => {
  const fell = await run(last(100_000));
  expect(fell.code).toBe(1);
  expect(fell.err).toContain("LOAD REGRESSION");
  expect((await run(last(10))).code).toBe(0);
});

test("the goal is no refusal and p95 under 100 ms; an edge result is never compared with a bypass one (#9514)", async () => {
  const { fell, missed } = await import("../src/perf/load_verdict.ts");
  const r = (o: object) => ({ version: "1", asked: 500, seconds: 20, served: 10_000, refused: 0, servedPerSecond: 500, p50: 3, p95: 40, ...o });
  expect(missed(r({}))).toBeUndefined();
  expect(missed(r({ refused: 3 }))).toContain("3 refused");
  expect(missed(r({ p95: 100 }))).toContain("p95 100 ms");
  expect(missed(r({ served: 0, servedPerSecond: 0 }))).toContain("none served");
  expect(fell(r({ cache: "bypass" }), r({ cache: "bypass" }))).toBeUndefined();
  expect(fell(r({}), r({ cache: "bypass" }))).toContain("like with like");
  // A result kept before #9514 has no cache field and reads as an edge run.
  expect(fell(r({}), r({ cache: "edge" }))).toBeUndefined();
});

test("--bypass sends every request with a cookie the edge must pass, --warm is not counted, and the result names its kind (#9514)", async () => {
  let withCookie = 0;
  let without = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (/\/(blob|raw)\//.test(new URL(req.url).pathname)) req.headers.get("cookie") === "forge_load=bypass" ? withCookie++ : without++;
      return new Response(`<a href="/o/r/blob/${oid}/f.txt">f</a>`, { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const p = Bun.spawn(["bun", "bench/load.ts", "--url", `http://127.0.0.1:${server.port}`, "--repo", "o/r", "--rate", "40", "--seconds", "1", "--warm", "1", "--bypass"], { stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    expect(code).toBe(0);
    const result = JSON.parse(out.slice(out.indexOf("{"), out.indexOf("\n}") + 2));
    expect(result.cache).toBe("bypass");
    expect(without).toBe(0);
    // Both phases asked; only the measured second is in the result.
    expect(withCookie).toBeGreaterThan(result.served);
    expect(result.served).toBeLessThanOrEqual(41);
    expect(out).toContain("warm-up, per second");
    expect(out).toContain("target met");
  } finally {
    server.stop(true);
  }
});
