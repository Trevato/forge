/**
 * The engine on a thread of its own (`FORGE_ENGINE=worker`, `src/engine/`):
 * the outbox as the one bus between two connections, a real Worker beside the
 * serving thread, what a crash of that Worker leaves behind, and exactly-once
 * pickup of a run by whoever asks first.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { tailEvents, type EventTail } from "../src/core/event_tail.ts";
import type { ForgeEvent } from "../src/core/events.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { engineMode } from "../src/engine/mode.ts";
import { live } from "../src/tui/screens/common.ts";
import { endOnSuspension } from "../src/tui/ssh.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startEngine, type Engine } from "../src/engine/host.ts";
import { transact } from "../src/kernel/db.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const WRITER = new URL("./helpers/engine_writer.ts", import.meta.url).href;
const dirs: string[] = [];
const apps: App[] = [];
const tails: EventTail[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const t of tails.splice(0)) t.stop();
  for (const a of apps.splice(0)) a.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  delete process.env["ENGINE_TEST"];
  delete process.env["ENGINE_TEST_REPO"];
});

async function forge(dir?: string): Promise<App> {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "forge-engine-")));
  if (dir === undefined) dirs.push(dataDir);
  const app = createApp({ dataDir, port: 0 });
  apps.push(app);
  return app;
}

const until = async (ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

describe("the mode", () => {
  test("is inline unless asked, and stays inline for a child, a standby and a test", () => {
    const where = { hosted: false, readOnly: false };
    expect(engineMode({}, where)).toBe("inline");
    expect(engineMode({ FORGE_ENGINE: "inline" }, where)).toBe("inline");
    expect(engineMode({ FORGE_ENGINE: "worker" }, where)).toBe("worker");
    expect(
      engineMode({ FORGE_ENGINE: "worker" }, { ...where, hosted: true }),
    ).toBe("inline");
    expect(
      engineMode({ FORGE_ENGINE: "worker" }, { ...where, readOnly: true }),
    ).toBe("inline");
    expect(
      engineMode({ FORGE_ENGINE: "worker", NODE_ENV: "test" }, where),
    ).toBe("inline");
    expect(
      engineMode(
        { FORGE_ENGINE: "worker", NODE_ENV: "test" },
        { ...where, optIn: true },
      ),
    ).toBe("worker");
  });
});

describe("the outbox is the one bus", () => {
  test("one thread: every listener hears every event as it is appended, as ever", async () => {
    const a = await forge();
    const heard: string[] = [];
    a.bus.subscribe((e) => heard.push(`ordered:${e.kind}`), "ordered");
    a.bus.subscribe((e) => heard.push(`inline:${e.kind}`));
    a.bus.subscribe((e) => heard.push(`local:${e.kind}`), "local");
    a.bus.append({ kind: "x.one" });
    expect(heard).toEqual(["ordered:x.one", "inline:x.one", "local:x.one"]);
  });

  test("split: what the other connection appended arrives in seq order; ordered hears its own only from the tail", async () => {
    const a = await forge();
    const b = await forge(a.config.dataDir);
    const tail = tailEvents(b.db, b.bus);
    tails.push(tail);
    const ordered: ForgeEvent[] = [];
    const inline: string[] = [];
    const local: string[] = [];
    b.bus.subscribe((e) => ordered.push(e), "ordered");
    b.bus.subscribe((e) => inline.push(e.kind));
    b.bus.subscribe((e) => local.push(e.kind), "local");

    a.bus.append({ kind: "from.a.1" });
    a.bus.append({ kind: "from.a.2" });
    b.bus.append({ kind: "from.b.1" });
    // b's own: inline and local at once, ordered not yet.
    expect(inline).toEqual(["from.b.1"]);
    expect(local).toEqual(["from.b.1"]);
    expect(ordered).toEqual([]);
    tail.catchUp();
    expect(ordered.map((e) => e.kind)).toEqual([
      "from.a.1",
      "from.a.2",
      "from.b.1",
    ]);
    expect(ordered.map((e) => e.seq)).toEqual([
      ordered[0]!.seq!,
      ordered[0]!.seq! + 1,
      ordered[0]!.seq! + 2,
    ]);
    // inline heard a's two from the tail and its own once, never twice; local only its own.
    expect(inline).toEqual(["from.b.1", "from.a.1", "from.a.2"]);
    expect(local).toEqual(["from.b.1"]);
    expect(b.bus.pendingOwn).toBe(0);
  });

  test("a rolled-back append is heard by no one and does not stay pending", async () => {
    const a = await forge();
    const b = await forge(a.config.dataDir);
    const tail = tailEvents(b.db, b.bus);
    tails.push(tail);
    const ordered: string[] = [];
    b.bus.subscribe((e) => ordered.push(e.kind), "ordered");
    expect(() =>
      transact(b.db, () => {
        b.bus.append({ kind: "phantom" });
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    b.bus.append({ kind: "real" });
    tail.catchUp();
    expect(ordered).toEqual(["real"]);
    expect(b.bus.pendingOwn).toBe(0);
  });

  test("a listener starts at the head: it never hears what was committed before it subscribed", async () => {
    const a = await forge();
    const b = await forge(a.config.dataDir);
    const tail = tailEvents(b.db, b.bus);
    tails.push(tail);
    a.bus.append({ kind: "before" });
    const heard: string[] = [];
    b.bus.subscribe((e) => heard.push(e.kind), "ordered");
    a.bus.append({ kind: "after" });
    tail.catchUp();
    expect(heard).toEqual(["after"]);
  });
});

describe("the engine thread", () => {
  test("starts, writes beside the serving thread, and what it appends is heard here in order without a gap", async () => {
    const serve = await forge();
    const tail = tailEvents(serve.db, serve.bus);
    tails.push(tail);
    const seqs: number[] = [];
    serve.bus.subscribe((e) => e.kind === "engine.probe" && seqs.push(e.seq!), "ordered");
    process.env["ENGINE_TEST"] = "writer";
    const engine = startEngine(serve.config, tail, { extra: [WRITER] });
    engines.push(engine);
    await engine.ready();
    await until(() => seqs.length >= 300);
    for (let i = 1; i < seqs.length; i++)
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    // And the serving thread writes meanwhile, in the same file, and reads what it wrote at once.
    for (let i = 0; i < 200; i++) {
      const made = serve.bus.append({ kind: "serve.probe", payload: { i } });
      const back = serve.db
        .query<
          { n: number },
          [string]
        >("SELECT COUNT(*) AS n FROM event WHERE id = ?1")
        .get(made.id);
      expect(back?.n).toBe(1);
    }
  }, 30_000);

  test("killed in the middle of a write: nothing half done is left, serving goes on, and the engine comes back", async () => {
    const serve = await forge();
    const tail = tailEvents(serve.db, serve.bus);
    tails.push(tail);
    process.env["ENGINE_TEST"] = "hang";
    const engine = startEngine(serve.config, tail, {
      extra: [WRITER],
      restartMinMs: 50,
    });
    engines.push(engine);
    // The first life commits one row, then opens a second transaction and never leaves it.
    await until(() => {
      try {
        return (
          (serve.db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) AS n FROM engine_scratch")
            .get()?.n ?? 0) >= 1
        );
      } catch {
        return false;
      }
    });
    await Bun.sleep(100);
    // It is inside the second transaction: it never said it was ready.
    expect(await Promise.race([engine.ready().then(() => "ready"), Bun.sleep(50).then(() => "stuck")])).toBe("stuck");
    engine.kill();
    // The lock went with the thread: this write does not wait for it.
    const t0 = performance.now();
    serve.bus.append({ kind: "serve.after.kill" });
    expect(performance.now() - t0).toBeLessThan(1_000);
    // The half-applied row and its event were rolled back with it.
    expect(
      serve.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM engine_scratch WHERE n = -99")
        .get()?.n,
    ).toBe(0);
    expect(
      serve.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM event WHERE kind = 'engine.half'")
        .get()?.n,
    ).toBe(0);
    // A new engine starts, runs its second life, and writes.
    await until(() => engine.restarts() === 1);
    await engine.ready();
    await until(
      () =>
        (serve.db
          .query<
            { n: number },
            []
          >("SELECT COUNT(*) AS n FROM engine_scratch WHERE life = 2")
          .get()?.n ?? 0) >= 50,
    );
    expect(
      Object.values(serve.db.query<Record<string, string>, []>("PRAGMA integrity_check").get() ?? {})[0],
    ).toBe("ok");
    expect(
      serve.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM pragma_foreign_key_check")
        .get()?.n,
    ).toBe(0);
  }, 30_000);

  test("an engine that stops saying it is alive is ended and started again", async () => {
    const serve = await forge();
    const tail = tailEvents(serve.db, serve.bus);
    tails.push(tail);
    process.env["ENGINE_TEST"] = "hang";
    const engine = startEngine(serve.config, tail, {
      extra: [WRITER],
      restartMinMs: 50,
      stallMs: 1_500,
    });
    engines.push(engine);
    // Stuck inside a write transaction from its first second, never ready: the watch ends it.
    await until(() => engine.restarts() === 1, 15_000);
    await engine.ready();
    expect(
      serve.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM engine_scratch WHERE n = -99")
        .get()?.n,
    ).toBe(0);
  }, 30_000);
});

describe("a run is started once", () => {
  test("two threads asking for the same queued runs: each run has exactly one taker", async () => {
    const serve = await forge();
    const tail = tailEvents(serve.db, serve.bus);
    tails.push(tail);
    const made = await createUser(serve.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = await createRepo(serve, made.value, {
      name: "r",
      visibility: "public",
    });
    if (!repo.ok) throw new Error(String(repo.error));
    const ids: string[] = [];
    transact(serve.db, () => {
      for (let i = 0; i < 3000; i++)
        ids.push(
          createRun(serve.db, {
            repoId: repo.value.id,
            kind: "check",
            commitOid: `c${i}`,
          }).id,
        );
    });
    process.env["ENGINE_TEST"] = "claimer";
    const engine = startEngine(serve.config, tail, { extra: [WRITER] });
    engines.push(engine);
    // This thread takes its first few before the engine is up (it may be quicker than this thread once it is), then they compete.
    let mine = 0;
    for (const id of ids.slice(0, 300)) if (claimRun(serve.db, id) !== undefined) mine++;
    await engine.ready();
    for (const id of ids) {
      if (claimRun(serve.db, id) !== undefined) mine++;
      if (mine % 10 === 0) await Bun.sleep(0);
    }
    // The engine counts a claim in a statement of its own, just after the claim: wait for the books to close.
    const theirsNow = (): number =>
      serve.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM engine_scratch WHERE n = -1").get()?.n ?? 0;
    await until(() => mine + theirsNow() >= 3000);
    await Bun.sleep(200);
    const theirs = theirsNow();
    expect(mine + theirs).toBe(3000);
    expect(serve.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run WHERE state = 'running'").get()?.n).toBe(3000);
    expect(mine).toBeGreaterThan(0);
    expect(theirs).toBeGreaterThan(0);
  }, 60_000);
});

describe("a stream that resumes while the engine writes", () => {
  test("sees every event after its cursor once, in the outbox's order, replay and live joined without a seam", async () => {
    const serve_ = await forge();
    const servers: Servers = await serve(serve_);
    try {
      const tail = tailEvents(serve_.db, serve_.bus);
      tails.push(tail);
      const made = await createUser(serve_.db, { origin: "seed", trusted: true, isAdmin: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = await createRepo(serve_, made.value, { name: "r", visibility: "public" });
      if (!repo.ok) throw new Error(String(repo.error));
      process.env["ENGINE_TEST"] = "writer";
      process.env["ENGINE_TEST_REPO"] = repo.value.id;
      process.env["ENGINE_TEST_KIND"] = "issue.labeled";
      process.env["ENGINE_TEST_EVERY_MS"] = "1";
      const engine = startEngine(serve_.config, tail, { extra: [WRITER] });
      engines.push(engine);
      await engine.ready();
      const kindsOf = (): { id: string; seq: number }[] =>
        serve_.db.query<{ id: string; seq: number }, [string]>("SELECT id, seq FROM event WHERE repo_id = ?1 AND kind = 'issue.labeled' ORDER BY seq").all(repo.value.id);
      await until(() => kindsOf().length >= 150);
      const cursor = kindsOf()[40]!;
      for (let round = 0; round < 5; round++) {
        const controller = new AbortController();
        const res = await fetch(`${servers.url}/events`, { headers: { "last-event-id": cursor.id }, signal: controller.signal });
        const got: string[] = [];
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const stop = Date.now() + 400;
        while (Date.now() < stop) {
          const chunk = await Promise.race([reader.read(), Bun.sleep(100).then(() => undefined)]);
          if (chunk === undefined) continue;
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const id = /^id: (.+)$/m.exec(buffer.slice(0, cut))?.[1];
            if (id !== undefined) got.push(id);
            buffer = buffer.slice(cut + 2);
          }
        }
        controller.abort();
        const seqOf = new Map(kindsOf().map((e) => [e.id, e.seq]));
        // Once each...
        expect(new Set(got).size).toBe(got.length);
        // ...in the outbox's order...
        const seqs = got.map((id) => seqOf.get(id)!);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
        // ...and none missing between its first and its last frame (the replay is the newest 200 after the cursor).
        const first = seqs[0]!;
        const last = seqs[seqs.length - 1]!;
        expect(got).toEqual(kindsOf().filter((e) => e.seq >= first && e.seq <= last).map((e) => e.id));
        expect(got.length).toBeGreaterThan(10);
      }
    } finally {
      delete process.env["ENGINE_TEST_KIND"];
      delete process.env["ENGINE_TEST_EVERY_MS"];
      servers.stop();
    }
  }, 60_000);
});

describe("the terminal's listeners are ordered too", () => {
  test("a live screen sees both threads' events once each in seq order, and none that rolled back", async () => {
    const a = await forge();
    const b = await forge(a.config.dataDir);
    const tail = tailEvents(b.db, b.bus);
    tails.push(tail);
    const seen: number[] = [];
    const stop = new AbortController();
    live({ app: b } as never, stop.signal, { where: (e) => (seen.push(e.seq!), false) }, () => {});
    for (let i = 0; i < 30; i++) (i % 2 === 0 ? a : b).bus.append({ kind: "x.tick" });
    expect(() =>
      transact(b.db, () => {
        b.bus.append({ kind: "phantom" });
        throw new Error("rolled back");
      }),
    ).toThrow();
    tail.catchUp();
    stop.abort();
    expect(seen.length).toBe(30);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
  });

  test("an ssh session ends when the other thread suspends its account, once, after the commit", async () => {
    const a = await forge();
    const b = await forge(a.config.dataDir);
    const tail = tailEvents(b.db, b.bus);
    tails.push(tail);
    const made = await createUser(b.db, { origin: "seed", trusted: true, username: "carol", email: "c@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(String(made.error));
    let exits = 0;
    const session = { ended: false, writeStderr: () => {}, exit: () => void exits++, onClose: () => {} };
    endOnSuspension(b as never, session as never, made.value);
    transact(a.db, () => a.bus.append({ kind: "account.suspended", payload: { username: "carol" } }));
    expect(exits).toBe(0);
    tail.catchUp();
    expect(exits).toBe(1);
  });
});
