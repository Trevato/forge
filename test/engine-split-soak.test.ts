/**
 * The split under load, with a person's eye on it: N clients each write a
 * change and read it straight back while the engine thread writes without
 * pause, and an event stream follows the outbox. Read-your-own-writes must
 * hold on every round trip; the stream must show the outbox's `seq` strictly
 * increasing and without a gap; the database must come out clean.
 *
 * `SPLIT_ROUND_TRIPS` (default 1000) sets the length, `SPLIT_ENGINE=inline`
 * runs the same writer on the serving thread instead, `SPLIT_DATA` names a
 * data directory to run on (a copy of a real forge's), and `SPLIT_REPORT=1`
 * prints the numbers.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { tailEvents, type EventTail } from "../src/core/event_tail.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { startEngine, type Engine } from "../src/engine/host.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import startWriter from "./helpers/engine_writer.ts";

quietLogs();

const TRIPS = Number(process.env["SPLIT_ROUND_TRIPS"] ?? 1000);
const CLIENTS = 16;
const INLINE = process.env["SPLIT_ENGINE"] === "inline";
const WRITER = new URL("./helpers/engine_writer.ts", import.meta.url).href;

let dataDir: string;
let own = false;
let app: App;
let servers: Servers;
let tail: EventTail | undefined;
let engine: Engine | undefined;
const heard = { ms: 0, events: 0 };
let stopWriter: (() => void) | undefined;
let tokens: string[] = [];
let owner = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  const given = process.env["SPLIT_DATA"];
  own = given === undefined;
  dataDir = given ?? (await mkdtemp(join(tmpdir(), "forge-soak-")));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const tag = Math.random().toString(36).slice(2, 8);
  owner = `soak${tag}`;
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true, isAdmin: true, username: owner,
    email: `${owner}@forge.local`,
    password: "a-good-passphrase",
  });
  if (!made.ok) throw new Error(String(made.error));
  // A token may make 600 requests a minute: enough tokens that none comes near it.
  tokens = Array.from({ length: Math.ceil((TRIPS * 2) / 400) + CLIENTS }, (_, i) => createToken(app.db, made.value.id, `soak${i}`, "rw").token);
  const repo = await createRepo(app, made.value, {
    name: "r",
    visibility: "public",
  });
  if (!repo.ok) throw new Error(String(repo.error));
  process.env["ENGINE_TEST"] = process.env["SPLIT_ENGINE_WRITES"] === "none" ? "idle" : "writer";
  process.env["ENGINE_TEST_REPO"] = repo.value.id;
  // A kind every reader of a public repository is told of, so the stream carries it.
  process.env["ENGINE_TEST_KIND"] = "issue.labeled";
  if (INLINE) stopWriter = startWriter(app);
  else {
    tail = tailEvents(app.db, app.bus);
    // As main.ts does it: the engine checkpoints, this thread's commits never do (`SPLIT_CKPT=serve` leaves it as it was).
    if (process.env["SPLIT_CKPT"] !== "serve") app.db.exec("PRAGMA wal_autocheckpoint = 0");
    // What the serving thread spends hearing the engine's events (every listener): the cost of a second writer.
    const hear = app.bus.deliver.bind(app.bus);
    app.bus.deliver = (event) => {
      const began = performance.now();
      hear(event);
      heard.ms += performance.now() - began;
      heard.events++;
    };
    engine = startEngine(app.config, tail, { extra: [WRITER] });
    await engine.ready();
  }
});

afterAll(async () => {
  stopWriter?.();
  await engine?.stop();
  tail?.stop();
  servers.stop();
  app.close();
  delete process.env["ENGINE_TEST"];
  delete process.env["ENGINE_TEST_REPO"];
  delete process.env["ENGINE_TEST_KIND"];
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  if (own) await rm(dataDir, { recursive: true, force: true });
});

/** Frames of a viewer's event stream, as `[id, kind]`, until aborted. */
async function follow(
  base: string,
  signal: AbortSignal,
  into: [string, string][],
  opened: () => void,
): Promise<void> {
  const res = await fetch(`${base}/events`, { signal });
  opened();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const id = /^id: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (id !== undefined && data !== undefined)
          into.push([id, (JSON.parse(data) as { kind: string }).kind]);
      }
    }
  } catch {
    // aborted
  }
}

test(`${TRIPS} write-then-read round trips beside a writing engine: none stale, the outbox in order, the file clean`, async () => {
  const base = servers.url;
  const frames: [string, string][] = [];
  const stream = new AbortController();
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const following = follow(base, stream.signal, frames, open);
  await opened;
  let turn = 0;
  const headersFor = (): Record<string, string> => ({
    authorization: `Bearer ${tokens[turn++ % tokens.length]}`,
    "content-type": "application/json",
  });
  const each = Math.ceil(TRIPS / CLIENTS);
  const mismatches: string[] = [];
  const lat: number[] = [];
  const postLat: number[] = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CLIENTS }, async (_, c) => {
      for (let i = 0; i < each; i++) {
        const title = `c${c}-${i}`;
        const began = performance.now();
        const made = await fetch(`${base}/api/v1/repos/${owner}/r/issues`, {
          method: "POST",
          headers: headersFor(),
          body: JSON.stringify({ title, body: "x" }),
        });
        postLat.push(performance.now() - began);
        if (made.status !== 201) {
          mismatches.push(
            `${title}: POST ${made.status} ${(await made.text()).slice(0, 80)}`,
          );
          continue;
        }
        const { number } = (await made.json()) as { number: number };
        const back = await fetch(
          `${base}/api/v1/repos/${owner}/r/issues/${number}`,
          { headers: headersFor() },
        );
        const got =
          back.status === 200
            ? ((await back.json()) as { title?: string })
            : undefined;
        if (got?.title !== title)
          mismatches.push(
            `${title}: read back ${back.status} ${JSON.stringify(got)?.slice(0, 80)}`,
          );
        lat.push(performance.now() - began);
      }
    }),
  );
  const took = performance.now() - t0;
  // Let the stream catch up with the last of it, then end it.
  await Bun.sleep(500);
  stream.abort();
  await following;

  expect(mismatches.slice(0, 5)).toEqual([]);
  expect(lat.length).toBe(each * CLIENTS);

  // The stream: every event of the repository between its first frame and its last, once, in `seq` order.
  const seqOf = new Map<string, number>();
  for (const row of app.db
    .query<{ id: string; seq: number }, [string]>("SELECT id, seq FROM event WHERE repo_id = ?1")
    .all(process.env["ENGINE_TEST_REPO"]!))
    seqOf.set(row.id, row.seq);
  expect(frames.length).toBeGreaterThan(each);
  const seqs = frames.map(([id]) => seqOf.get(id));
  expect(seqs.includes(undefined)).toBe(false);
  for (let i = 1; i < seqs.length; i++)
    if (!(seqs[i]! > seqs[i - 1]!))
      throw new Error(`frame ${i}: seq ${seqs[i]} after ${seqs[i - 1]}`);
  const kinds = new Set(frames.map(([, kind]) => kind));
  const first = seqs[0]!;
  const last = seqs[seqs.length - 1]!;
  const expected = app.db
    .query<{ id: string; kind: string }, [number, number, string]>(
      "SELECT id, kind FROM event WHERE repo_id = ?3 AND seq BETWEEN ?1 AND ?2 ORDER BY seq",
    )
    .all(first, last, process.env["ENGINE_TEST_REPO"]!)
    .filter((e) => kinds.has(e.kind));
  expect(frames.map(([id]) => id)).toEqual(expected.map((e) => e.id));
  if (process.env["SPLIT_ENGINE_WRITES"] !== "none") expect(frames.filter(([, kind]) => kind === "issue.labeled").length).toBeGreaterThan(50);

  // The file after the soak.
  stopWriter?.();
  await engine?.stop();
  engine = undefined;
  const integrity = Object.values(
    app.db.query<Record<string, string>, []>("PRAGMA integrity_check").get() ??
      {},
  )[0];
  if (own || process.env["SPLIT_FULL_CHECK"] === "1")
    expect(integrity).toBe("ok");
  expect(
    app.db.query("SELECT * FROM pragma_foreign_key_check LIMIT 1").all(),
  ).toEqual([]);
  const wrote =
    app.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM engine_scratch")
      .get()?.n ?? 0;
  if (process.env["SPLIT_ENGINE_WRITES"] !== "none") expect(wrote).toBeGreaterThan(100);

  if (process.env["SPLIT_REPORT"] === "1") {
    lat.sort((a, b) => a - b);
    const q = (p: number) => lat[Math.floor(lat.length * p)]!.toFixed(1);
    console.log(
      JSON.stringify({
        engine: INLINE ? "inline" : "worker",
        roundTrips: lat.length,
        mismatches: mismatches.length,
        seconds: +(took / 1000).toFixed(1),
        perSecond: Math.round((lat.length / took) * 1000),
        postMs: { p50: +postLat.sort((a, b) => a - b)[postLat.length >> 1]!.toFixed(1), p99: +postLat[Math.floor(postLat.length * 0.99)]!.toFixed(1) },
        pairMs: {
          p50: +q(0.5),
          p99: +q(0.99),
          max: +lat[lat.length - 1]!.toFixed(1),
        },
        streamFrames: frames.length,
        eventsFirstLast: [first, last],
        engineRows: wrote,
        tail: { events: heard.events, ms: Math.round(heard.ms), usPerEvent: heard.events === 0 ? 0 : Math.round((heard.ms / heard.events) * 1000) },
        integrity,
      }),
    );
  }
}, 900_000);
