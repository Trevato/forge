/** `/explore`'s Server-Timing names its phases: session, read, render (#3230). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;

beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

for (const path of ["/explore", "/explore?q=" + encodeURIComponent("kind:app sort:forks")]) {
  test(`GET ${path} names session, read and render beside the route total`, async () => {
    const res = await fetch(`${f.base}${path}`);
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    const parts = (res.headers.get("server-timing") ?? "").split(", ");
    for (const name of ["app", "session", "read", "render"])
      expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  });
}
