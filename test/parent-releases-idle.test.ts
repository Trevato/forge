import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshIdle,
  refreshParentReleases,
} from "../src/core/parent_releases.ts";

test("refreshIdle resolves at once with nothing in flight, and waits for a slow refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-idle-"));
  try {
    await refreshIdle(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      await gate;
      return Response.json({
        releases: [{ name: "1.0.0", url: "http://127.0.0.1/r" }],
      });
    }) as unknown as typeof fetch;
    void refreshParentReleases(dir, "http://127.0.0.1:1", {
      loopback: true,
      fetch: slow,
    });
    let idle = false;
    const waiting = refreshIdle(dir).then(() => (idle = true));
    await Bun.sleep(30);
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(idle).toBe(true);
    const stored = JSON.parse(
      await Bun.file(join(dir, "parent-releases.json")).text(),
    );
    expect(stored.ok).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 304 keeps the copy and moves fetchedAt; a 200 replaces copy and ETag; a malformed ETag is ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-etag-"));
  const url = "http://127.0.0.1:1";
  const seen: (string | null)[] = [];
  let answer: () => Response = () => new Response();
  const f = (async (_u: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("if-none-match"));
    return answer();
  }) as unknown as typeof fetch;
  const doc = (name: string, etag: string) => () =>
    new Response(
      JSON.stringify({ releases: [{ name, url: "http://127.0.0.1/r" }] }),
      { headers: { etag } },
    );
  const read = async () =>
    JSON.parse(await Bun.file(join(dir, "parent-releases.json")).text());
  try {
    answer = doc("1.0.0", '"a"');
    await refreshParentReleases(dir, url, { loopback: true, fetch: f, now: 1 });
    expect((await read()).etag).toBe('"a"');
    answer = () => new Response(null, { status: 304 });
    await refreshParentReleases(dir, url, { loopback: true, fetch: f, now: 2 });
    const kept = await read();
    expect(seen).toEqual([null, '"a"']);
    expect(kept.fetchedAt).toBe(2);
    expect(kept.ok).toBe(true);
    expect(kept.etag).toBe('"a"');
    expect(kept.releases[0].name).toBe("1.0.0");
    answer = doc("2.0.0", '"b"');
    await refreshParentReleases(dir, url, { loopback: true, fetch: f, now: 3 });
    const next = await read();
    expect(next.etag).toBe('"b"');
    expect(next.releases[0].name).toBe("2.0.0");
    answer = doc("3.0.0", "W/bad");
    await refreshParentReleases(dir, url, { loopback: true, fetch: f, now: 4 });
    expect((await read()).etag).toBeUndefined();
    await refreshParentReleases(dir, url, { loopback: true, fetch: f, now: 5 });
    expect(seen.at(-1)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
