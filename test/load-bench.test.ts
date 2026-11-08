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
