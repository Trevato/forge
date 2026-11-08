/**
 * "Running" is proven from outside (#7959): the parent asks a child's public
 * addresses as a visitor does, asserts the answer is the child's and the
 * app's own (a platform's standby page answers 200 for any name), keeps what
 * came back, and alarms once on a change.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { clientRows, runningWords, useChildFetch } from "../src/spawn/clients.ts";
import { Database } from "bun:sqlite";
import { childDirOf } from "../src/actions/spawn.ts";
import { appUrlOf, slugsOf, proveApp, proveHome, reachAlarms, reachOf, reachWords, sweepReach, useReach } from "../src/spawn/reach.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const standby = () => new Response("<h1>This site is on standby</h1>", { status: 200, headers: { "content-type": "text/html" } });

describe("a probe asserts the answer, not the status", () => {
  test("the platform's standby page is a 200 and is not the child", async () => {
    expect(standby().status).toBe(200);
    const home = await proveHome(async () => standby(), { url: "https://kid--forge.test" });
    expect(home).toMatchObject({ ok: false, status: 200, says: "answered 200, not by the forge" });
  });

  test("the child's home is its own /api/v1/forge", async () => {
    const seen: string[] = [];
    const home = await proveHome(async (url) => (seen.push(url), Response.json({ claimed: false })), { url: "https://kid--forge.test" });
    expect(seen).toEqual(["https://kid--forge.test/api/v1/forge"]);
    expect(home.ok).toBe(true);
  });

  test("an app is the one that carries its own slug; a 200 without it is not it", async () => {
    const own = await proveApp(async () => new Response("hi", { headers: { "x-forge-app": "deal" } }), "https://deal--kid--forge.test/", "deal");
    expect(own).toMatchObject({ ok: true, status: 200 });
    const other = await proveApp(async () => standby(), "https://deal--kid--forge.test/", "deal");
    expect(other).toMatchObject({ ok: false, status: 200, says: "answered 200, not by the app" });
    const wrong = await proveApp(async () => new Response("x", { headers: { "x-forge-app": "other" } }), "https://deal--kid--forge.test/", "deal");
    expect(wrong.ok).toBe(false);
  });

  test("the status is kept: a 404 from the platform, a 500 from the app, no answer at all", async () => {
    const miss = await proveApp(async () => new Response("not found", { status: 404 }), "https://a--k--f.test/", "a");
    expect(miss).toMatchObject({ ok: false, status: 404, says: "answered 404, not by the app" });
    const broke = await proveApp(async () => new Response("x", { status: 502, headers: { "x-forge-app": "a" } }), "https://a--k--f.test/", "a");
    expect(broke).toMatchObject({ ok: false, status: 502, says: "the app answered 502" });
    const none = await proveApp(async () => Promise.reject(new Error("connection refused")), "https://a--k--f.test/", "a");
    expect(none).toMatchObject({ ok: false, status: null });
    expect(none.says).toContain("no answer");
  });
});

describe("a forge watches its children's addresses", () => {
  let dir = "";
  let parent: App;
  /** What each public address answers right now; absent is "no answer". */
  const world = new Map<string, () => Response>();
  const asked: string[] = [];

  const events = (kind: string) => listEvents(parent.db, { kind, limit: 20 });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-reach-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    mkdirSync(join(dir, "spawn"), { recursive: true });
    writeFileSync(
      join(dir, "spawn", "kid.json"),
      JSON.stringify({ name: "kid", bodyId: "cell-k", done: true, placement: "hosted", size: "small", apps: ["alice/deal-clock"], createdAt: "2026-11-01T00:00:00.000Z" }),
    );
    useChildFetch(parent, async () => Response.json({ claimed: true, lastActivityAt: new Date().toISOString() }));
    useReach(parent, {
      confirmMs: 0,
      fetch: async (url) => {
        asked.push(url);
        const answer = world.get(url);
        if (answer === undefined) throw new Error("ENOTFOUND");
        return answer();
      },
    });
  });

  afterAll(() => parent.close());

  test("the app's address is <app>--<child>--<parentHost>", () => {
    expect(appUrlOf(parent, { name: "kid" }, "deal-clock")).toBe("https://deal-clock--kid--forge.test/");
  });

  test("a child whose addresses answer with standby pages is running, not reachable: kept, alarmed once, listed", async () => {
    world.set("https://kid--forge.test/api/v1/forge", () => Response.json({ claimed: true }));
    world.set("https://deal-clock--kid--forge.test/", () => new Response("not found", { status: 404 }));
    await sweepReach(parent);
    await sweepReach(parent);
    const reach = reachOf(parent, "kid")!;
    expect(reach.ok).toBe(false);
    expect(reach.proofs.map((p) => [p.label, p.ok, p.status])).toEqual([["home", true, 200], ["deal-clock", false, 404]]);
    expect(reachWords(reach)).toBe("Running, not reachable: deal-clock answered 404, not by the app");
    // One page for the standing failure, not one per sweep.
    expect(events("forge.child_unreachable")).toHaveLength(1);
    const [alarm] = reachAlarms(parent);
    expect(alarm).toMatchObject({ key: "unreachable", href: "/forges", since: reach.since! });
    expect(alarm!.says).toContain("kid is running, not reachable");
    const [row] = await clientRows(parent);
    expect(row!.reach?.ok).toBe(false);
    expect(row!.attention).toBe("down");
    expect(runningWords(row!)).toBe("Running, not reachable: deal-clock answered 404, not by the app");
  });

  test("when it answers again the alarm ends, once", async () => {
    world.set("https://deal-clock--kid--forge.test/", () => new Response("deal", { headers: { "x-forge-app": "deal-clock" } }));
    await sweepReach(parent);
    await sweepReach(parent);
    expect(reachOf(parent, "kid")).toMatchObject({ ok: true, since: null, alarmed: false });
    expect(reachAlarms(parent)).toEqual([]);
    expect(events("forge.child_reachable")).toHaveLength(1);
    const [row] = await clientRows(parent);
    expect(row!.attention).not.toBe("down");
  });

  test("one dropped request pages nobody: a failure is confirmed before it is believed", async () => {
    const before = events("forge.child_unreachable").length;
    let calls = 0;
    world.set("https://kid--forge.test/api/v1/forge", () => (++calls === 1 ? new Response("oops", { status: 502 }) : Response.json({ claimed: true })));
    await sweepReach(parent);
    expect(calls).toBe(2);
    expect(reachOf(parent, "kid")?.ok).toBe(true);
    expect(events("forge.child_unreachable")).toHaveLength(before);
  });

  test("a slug a child writes that is not the forge's slug rule is never asked", async () => {
    const child = { name: "kid", bodyId: "cell-k", done: true, placement: "hosted", size: "small", apps: ["alice/deal-clock"], createdAt: "" } as never;
    mkdirSync(childDirOf(parent, "cell-k"), { recursive: true });
    const db = new Database(join(childDirOf(parent, "cell-k"), "forge.db"));
    db.run("CREATE TABLE app (slug TEXT, access TEXT)");
    for (const slug of ["evil.example#", "u@host", "a/b", "UP", "ok-app"]) db.run("INSERT INTO app VALUES (?, 'public')", [slug]);
    db.close();
    expect(slugsOf(parent, child)).toEqual(["deal-clock", "ok-app"]);
    asked.length = 0;
    await sweepReach(parent);
    expect(asked.filter((u) => /evil|@|%|#|\/\/[^/]*\/[^/]/.test(u.replace(/^https:\/\//, "")) && !u.endsWith("/api/v1/forge"))).toEqual([]);
    expect(asked.every((u) => new URL(u).hostname.endsWith("--kid--forge.test") || u === "https://kid--forge.test/api/v1/forge")).toBe(true);
  });
});
