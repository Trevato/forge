/** The dead-man probe goes red when the forge or the bucket is silent, and green only when both speak. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProbeArgs, probe } from "../src/snapshot/probe.ts";
import { dirStore } from "../src/snapshot/store.ts";

const root = mkdtempSync(join(tmpdir(), "probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-02T12:00:00Z");
async function bucketWith(finishedAt: string | undefined) {
  const dir = mkdtempSync(join(root, "b-"));
  const store = dirStore(dir);
  if (finishedAt)
    await store.put("snapshots/s1/manifest.json", JSON.stringify({ name: "s1", finishedAt, files: [] }));
  return store;
}
const up = async () => ({ status: 200 });
const FORGE = "https://forge.example";

describe("probe", () => {
  test("green: a fresh snapshot and a forge that answers", async () => {
    const r = await probe({ store: await bucketWith("2026-11-02T08:00:00Z"), forgeUrl: FORGE, now: NOW, fetch: up });
    expect(r.ok).toBe(true);
  });
  test("red: the forge is silent while the bucket is fresh", async () => {
    const r = await probe({
      store: await bucketWith("2026-11-02T08:00:00Z"), forgeUrl: FORGE, now: NOW,
      fetch: async () => { throw new Error("refused"); },
    });
    expect(r.ok).toBe(false);
    expect(r.findings.find((f) => f.what === "forge")?.ok).toBe(false);
    expect(r.findings.find((f) => f.what === "bucket")?.ok).toBe(true);
  });
  test("red: the forge answers 503", async () => {
    const r = await probe({ store: await bucketWith("2026-11-02T08:00:00Z"), forgeUrl: FORGE, now: NOW, fetch: async () => ({ status: 503 }) });
    expect(r.ok).toBe(false);
  });
  test("red: the bucket's newest snapshot is older than 36 h, forge fine", async () => {
    const r = await probe({ store: await bucketWith("2026-10-31T08:00:00Z"), forgeUrl: FORGE, now: NOW, fetch: up });
    expect(r.ok).toBe(false);
    expect(r.findings.find((f) => f.what === "bucket")?.detail).toContain("52 h old");
  });
  test("red: an empty bucket, no store, no URL, a non-http URL", async () => {
    expect((await probe({ store: await bucketWith(undefined), forgeUrl: FORGE, now: NOW, fetch: up })).ok).toBe(false);
    expect((await probe({ store: undefined, forgeUrl: FORGE, now: NOW, fetch: up })).ok).toBe(false);
    expect((await probe({ store: await bucketWith("2026-11-02T08:00:00Z"), forgeUrl: undefined, now: NOW, fetch: up })).ok).toBe(false);
    expect((await probe({ store: await bucketWith("2026-11-02T08:00:00Z"), forgeUrl: "file:///etc", now: NOW, fetch: up })).ok).toBe(false);
  });
  test("red: a bucket that cannot be read", async () => {
    const broken = { ...dirStore(root), names: async () => { throw new Error("403"); } };
    const r = await probe({ store: broken, forgeUrl: FORGE, now: NOW, fetch: up });
    expect(r.findings[1]?.detail).toContain("unreadable");
  });
  test("red: a forge that never answers, within the timeout", async () => {
    const hang = (_u: string, i: { signal: AbortSignal }) =>
      new Promise<{ status: number }>((_, rej) => i.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const r = await probe({ store: await bucketWith("2026-11-02T08:00:00Z"), forgeUrl: FORGE, now: NOW, fetch: hang, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    expect(r.findings[0]?.detail).toContain("did not answer");
  });
  test("red: a redirect is not followed and is not green", async () => {
    let init: { redirect?: string } | undefined;
    const r = await probe({
      store: await bucketWith("2026-11-02T08:00:00Z"), forgeUrl: FORGE, now: NOW,
      fetch: async (_u, i) => { init = i; return { status: 301 }; },
    });
    expect(init?.redirect).toBe("manual");
    expect(r.ok).toBe(false);
    expect(r.findings[0]?.detail).toContain("301");
  });
  test("red: a snapshot dated in the future is not fresh; a few minutes of skew is", async () => {
    const far = await probe({ store: await bucketWith("2026-11-03T12:00:00Z"), forgeUrl: FORGE, now: NOW, fetch: up });
    expect(far.ok).toBe(false);
    expect(far.findings[1]?.detail).toContain("future");
    const skew = await probe({ store: await bucketWith("2026-11-02T12:02:00Z"), forgeUrl: FORGE, now: NOW, fetch: up });
    expect(skew.ok).toBe(true);
  });
  test("the newest snapshot decides, whatever order the store lists them or they were written", async () => {
    const store = dirStore(mkdtempSync(join(root, "two-")));
    const put = (name: string, finishedAt: string) =>
      store.put(`snapshots/${name}/manifest.json`, JSON.stringify({ name, finishedAt, files: [] }));
    await put("2026-11-02T08-00-00Z", "2026-11-02T08:00:00Z");
    await put("2026-10-01T08-00-00Z", "2026-10-01T08:00:00Z");
    expect((await probe({ store, forgeUrl: FORGE, now: NOW, fetch: up })).ok).toBe(true);
    const stale = dirStore(mkdtempSync(join(root, "stale-")));
    await stale.put("snapshots/b/manifest.json", JSON.stringify({ name: "b", finishedAt: "2026-10-01T08:00:00Z", files: [] }));
    await stale.put("snapshots/a/manifest.json", JSON.stringify({ name: "a", finishedAt: "2026-09-01T08:00:00Z", files: [] }));
    expect((await probe({ store: stale, forgeUrl: FORGE, now: NOW, fetch: up })).findings[1]?.detail).toContain("snapshot b ");
  });
});

describe("parseProbeArgs", () => {
  test("reads flags and defaults to 36 h and FORGE_URL", () => {
    expect(parseProbeArgs(["--forge", "https://f", "--dir", "/d"])).toEqual({ forgeUrl: "https://f", dir: "/d", maxAgeMs: 36 * 3_600_000 });
    expect(parseProbeArgs([], { FORGE_URL: "https://e" })).toMatchObject({ forgeUrl: "https://e" });
    expect(parseProbeArgs(["--max-age-hours", "2"])).toMatchObject({ maxAgeMs: 7_200_000 });
  });
  test("a flag with no value, an unknown flag, and a bad age are errors", () => {
    expect(parseProbeArgs(["--forge"])).toEqual({ error: "--forge needs a value" });
    expect(parseProbeArgs(["--forge", "--dir", "x"])).toEqual({ error: "--forge needs a value" });
    expect(parseProbeArgs(["--nope", "1"])).toHaveProperty("error");
    for (const bad of ["0", "-1", "abc", ""]) expect(parseProbeArgs(["--max-age-hours", bad])).toHaveProperty("error");
  });
});

describe("scripts/backup-probe.ts", () => {
  const run = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/backup-probe.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env["PATH"] ?? "" } });
    return { code: await p.exited, out: await new Response(p.stdout).text() };
  };
  test("exit 2 on bad arguments; exit 1 when red", async () => {
    expect((await run(["--max-age-hours", "0"])).code).toBe(2);
    expect((await run(["--forge"])).code).toBe(2);
    const dir = mkdtempSync(join(root, "cli-"));
    const r = await run(["--forge", "http://127.0.0.1:1", "--dir", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("RED forge");
  });
  test("exit 0 when both are green", async () => {
    const dir = mkdtempSync(join(root, "cli-"));
    await dirStore(dir).put("snapshots/s/manifest.json", JSON.stringify({ name: "s", finishedAt: new Date().toISOString(), files: [] }));
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      expect((await run(["--forge", `http://127.0.0.1:${server.port}`, "--dir", dir])).code).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
