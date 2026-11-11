/** A repository's issues list names its Server-Timing phases in order: session, issues, closing, words, labels, render. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let f: SnappyFixture;

beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

for (const who of ["owner", "anonymous"] as const) {
  test(`${who}: the issues list names its phases in order`, async () => {
    const repo = f.repos[0]!;
    const res = await fetch(`${f.base}/${repo.ownerName}/${repo.name}/issues`, {
      headers: who === "owner" ? { cookie: f.ownerCookie } : {},
    });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
    expect(names.filter((n) => n !== "app")).toEqual(["session", "issues", "closing", "words", "labels", "render"]);
  });
}
