/** An issue page's Server-Timing names session, thread, links and render, and they fit inside app. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;

beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

async function timing(cookie?: string): Promise<Map<string, number>> {
  const repo = f.repos[0]!;
  const res = await fetch(`${f.base}/${repo.ownerName}/${repo.name}/issues/4`, {
    headers: cookie ? { cookie } : {},
  });
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  const got = new Map<string, number>();
  for (const part of (res.headers.get("server-timing") ?? "").split(", ")) {
    const m = /^([a-z-]+);dur=(\d+\.\d)/.exec(part);
    if (m) got.set(m[1]!, Number(m[2]));
  }
  return got;
}

for (const who of ["owner", "anonymous"] as const) {
  test(`${who}: the issue page names its four phases and they sum to no more than app`, async () => {
    const got = await timing(who === "owner" ? f.ownerCookie : undefined);
    const phases = ["session", "thread", "links", "render"];
    for (const name of phases) expect(got.has(name)).toBe(true);
    const sum = phases.reduce((n, name) => n + got.get(name)!, 0);
    // Each is rounded to a tenth of a millisecond.
    expect(sum).toBeLessThanOrEqual(got.get("app")! + 0.4);
  });
}
