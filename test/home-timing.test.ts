/** `/`'s Server-Timing names its regions, and only the ones the viewer can see. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { serverTiming } from "../src/core/route_timing.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;

beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

async function timing(cookie?: string): Promise<string[]> {
  const res = await fetch(`${f.base}/`, { headers: cookie ? { cookie } : {} });
  await res.arrayBuffer();
  return (res.headers.get("server-timing") ?? "").split(", ");
}
const names = (parts: string[]): string[] => parts.map((p) => p.split(";")[0]!);

test("the owner's home names feed, kpis and panels; a warm look is a hit", async () => {
  await timing(f.ownerCookie);
  const warm = await timing(f.ownerCookie);
  expect(names(warm)).toEqual(expect.arrayContaining(["feed", "kpis", "panels"]));
  expect(names(warm)).not.toContain("shelf");
  expect(warm.find((p) => p.startsWith("kpis;"))).toMatch(/^kpis;dur=\d+\.\d;desc="hit"$/);
  expect(warm.find((p) => p.startsWith("feed;"))).toMatch(/^feed;dur=\d+\.\d;desc="hit"$/);
});

test("a signed-in non-admin gets the feed and none of the admin-only phases", async () => {
  const got = names(await timing(f.peerCookie));
  expect(got).toContain("feed");
  expect(got).not.toContain("kpis");
  expect(got).not.toContain("panels");
});

test("an anonymous home names its shelf and nothing admin-only", async () => {
  const got = names(await timing());
  expect(got).toContain("shelf");
  for (const n of ["kpis", "panels", "feed"]) expect(got).not.toContain(n);
});

test("a hit is written as desc, a miss is not", () => {
  expect(serverTiming(1, undefined, [{ name: "feed", ms: 0.5, hit: true }, { name: "kpis", ms: 2 }])).toBe(
    'app;dur=1.0, feed;dur=0.5;desc="hit", kpis;dur=2.0',
  );
});
