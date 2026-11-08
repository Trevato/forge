/**
 * The `cell` placement: a child forge as a process of its own. It is
 * `bun src/main.ts` with its data directory, started from `childEnv`
 * (invariant 11) inside a cell (`apps/contain.ts`) whose memory, CPU and
 * disk are its size's (`spawn/sizes.ts`). The parent keeps answering
 * `<name>--<host>` and forwards to the loopback port the cell relays in on
 * (`forward`). Where the host cannot hold a cell the child is hosted
 * (`spawn/placement.ts` `fallbackPlacement`), and the ledger says which.
 */

import { dirname, join } from "node:path";
import { clientAddress } from "../http/peer.ts";
import type { App } from "../app.ts";
import { connectUpstream, offeredProtocols, type AppSocket } from "../apps/proxy.ts";
import { cellsAvailable, killTree, openCell, type Cell, type CellSpec, type Limits } from "../apps/contain.ts";
import { childEnv, freePort } from "../apps/process.ts";
import { childDirOf } from "../actions/spawn.ts";
import { openBeatDoor, parentLocal, type BeatDoor } from "./beat-door.ts";
import { hostedPlacement, parentOrigin, childPublicUrl, type BodyStore, type Placement } from "./placement.ts";
import { SIZES, type Size } from "./sizes.ts";
import { childModelHosts } from "../core/capacity.ts";

export const CELL_PREFIX = "cell-";
export const ownsBody = (bodyId: string): boolean => bodyId.startsWith(CELL_PREFIX);

/** After a child fails to start, requests are answered 503 at once for this long. */
export const START_BACKOFF_MS = 30_000;

const MAIN = join(import.meta.dir, "..", "main.ts");
const CODE = join(import.meta.dir, "..", "..");

/** A size's limits as a cell holds them. */
export function cellLimits(size: Size): Limits {
  const s = SIZES[size];
  return { memoryMiB: s.memoryMiB, cpus: s.cpu, diskMiB: s.diskMiB };
}

/** The cell a child of `size` runs in; plain data, so a test reads the limits off it. */
export function cellSpecFor(input: {
  dir: string;
  parentDataDir: string;
  parentUrl: string;
  /** The parent's heartbeat door (`beat-door.ts`): the only way to it that needs no public address (a preview's cell has none). */
  parentPort?: number;
  size: Size;
  port: number;
  label: string;
  /** The model provider hosts an admin let children reach (`children.modelEgress`); none by default. */
  modelHosts?: readonly string[];
}): CellSpec {
  return {
    dir: input.dir,
    writable: [],
    home: join(input.dir, ".home"),
    // The parent's data is the one thing a child must not see; its own
    // directory sits under it and is bound back, deepest last.
    hide: [input.parentDataDir],
    // The forge's own code may live under the parent's data (a release checkout).
    reveal: [CODE],
    egress: [...(input.modelHosts ?? [])],
    // A child's cell is held to this list whatever cells.egress says: report
    // mode is for apps still declaring hosts, not for a whole forge.
    egressMode: "enforce",
    reach: input.parentPort === undefined ? [input.parentUrl] : [input.parentUrl, parentLocal(input.parentPort)],
    limits: cellLimits(input.size),
    listen: input.port,
    label: input.label,
  };
}

/** The child forge's environment: short, explicit, and its own. */
export function cellEnv(input: { port: number; dataDir: string; url: string; parentPort?: number }): Record<string, string> {
  const env = childEnv({
    PORT: String(input.port),
    FORGE_HOST: "127.0.0.1",
    FORGE_APP_URL: input.url,
    FORGE_APP_DATA: input.dataDir,
    NODE_ENV: "production",
    ...(input.parentPort === undefined ? {} : { FORGE_PARENT_LOCAL: parentLocal(input.parentPort) }),
  });
  delete env["USER"];
  delete env["LOGNAME"];
  return env;
}

export interface CellChild {
  readonly bodyId: string;
  readonly name: string;
  readonly size: Size;
  readonly port: number;
  readonly limits: Limits;
  readonly pid: number;
  readonly exited: Promise<number>;
}

interface Held extends CellChild {
  readonly door: BeatDoor;
  readonly cell: Cell;
  readonly proc: ReturnType<typeof Bun.spawn>;
}

export interface CellChildren {
  /** Start the child (idempotent); resolves once it answers, or says why not. */
  start(input: { bodyId: string; name: string; size: Size }): Promise<CellChild | undefined>;
  stop(bodyId: string): Promise<void>;
  get(bodyId: string): CellChild | undefined;
  /** Why the last start failed, in a sentence a person can read; undefined when it did not. */
  failure(bodyId: string): string | undefined;
  list(): readonly CellChild[];
  /** Mark a request under way for this child; the returned function ends it. A child with one is not put to sleep. */
  hold(bodyId: string): () => void;
  /** Note that a request just reached this child, so it is not idle. */
  touch(bodyId: string, now?: number): void;
  /** Stop every running child quiet for `idleMs`; the names of those stopped (their data stays on disk). */
  sleepIdle(idleMs: number, now?: number): Promise<string[]>;
}

const registries = new WeakMap<App, CellChildren>();

export function cellChildren(parent: App): CellChildren {
  let r = registries.get(parent);
  if (r === undefined) registries.set(parent, (r = makeRegistry(parent)));
  return r;
}

async function answers(port: number, gone: Promise<unknown>): Promise<boolean> {
  let over = false;
  void gone.then(() => (over = true));
  for (let i = 0; i < 300 && !over; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

function makeRegistry(parent: App): CellChildren {
  const held = new Map<string, Held>();
  const starting = new Map<string, Promise<CellChild | undefined>>();
  /** When a start last failed: a broken child is not relaunched on every request. */
  const failed = new Map<string, { at: number; why: string }>();
  /** Held once it answers, never before: a start in flight is in `starting`. */
  /** When a request last reached each running child, ms. */
  const seen = new Map<string, number>();
  /** Requests under way, by body id. */
  const busy = new Map<string, number>();

  const launch = async (input: { bodyId: string; name: string; size: Size }): Promise<CellChild | undefined> => {
    const cells = await cellsAvailable();
    if (!cells.ok) {
      parent.log.warn("child cell not started", { name: input.name, reason: cells.reason });
      failed.set(input.bodyId, { at: Date.now(), why: cells.reason });
      return undefined;
    }
    const recent: string[] = [];
    const port = freePort();
    const dir = childDirOf(parent, input.bodyId);
    const url = childPublicUrl(input.name, parentOrigin(parent.config));
    const door = openBeatDoor(parent);
    const parentPort = door.port;
    const spec = cellSpecFor({
      dir,
      parentDataDir: parent.config.dataDir,
      parentUrl: parentOrigin(parent.config),
      parentPort,
      size: input.size,
      port,
      label: `forge:${input.name}`,
      modelHosts: childModelHosts(parent.db),
    });
    const log = (line: string): void => {
      recent.push(line);
      if (recent.length > 5) recent.shift();
      parent.log.info("child forge", { name: input.name, line });
    };
    let cell: Cell;
    try {
      cell = openCell(spec, log);
    } catch (error) {
      door.close();
      throw error;
    }
    const command = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(MAIN)}`;
    const proc = Bun.spawn(cell.argv(command), {
      cwd: dirname(MAIN),
      env: cell.env(cellEnv({ port, dataDir: dir, url, parentPort })),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const exited = proc.exited.then((code) => {
      const why = cell.breach();
      if (why !== undefined) parent.log.warn("child forge stopped", { name: input.name, why });
      cell.close();
      door.close();
      if (held.get(input.bodyId)?.proc === proc) held.delete(input.bodyId);
      if (why !== undefined) recent.push(why);
      return code;
    });
    cell.watch(proc.pid, () => killTree(proc.pid));
    void drain(proc.stdout, log);
    void drain(proc.stderr, log);
    const child: Held = { ...input, port, limits: spec.limits, pid: proc.pid, exited, cell, proc, door };
    if (!(await answers(port, exited))) {
      const why = `its cell did not come up: ${recent.slice(-3).join(" | ") || "no output"}`.slice(0, 400);
      parent.log.warn("child forge did not answer", { name: input.name, why });
      failed.set(input.bodyId, { at: Date.now(), why });
      killTree(proc.pid);
      return undefined;
    }
    held.set(input.bodyId, child);
    seen.set(input.bodyId, Date.now());
    return child;
  };

  return {
    start(input) {
      const there = held.get(input.bodyId);
      if (there !== undefined) return Promise.resolve(there);
      const lastFailure = failed.get(input.bodyId);
      if (lastFailure !== undefined && Date.now() - lastFailure.at < START_BACKOFF_MS) return Promise.resolve(undefined);
      let flight = starting.get(input.bodyId);
      if (flight === undefined) {
        flight = launch(input)
          .catch((error: unknown) => {
            const why = `its cell could not be made: ${String(error)}`.slice(0, 400);
            parent.log.warn("child forge could not start", { name: input.name, why });
            failed.set(input.bodyId, { at: Date.now(), why });
            return undefined;
          })
          .then((child) => {
            if (child !== undefined) failed.delete(input.bodyId);
            return child;
          });
        starting.set(input.bodyId, flight);
        void flight.finally(() => starting.delete(input.bodyId)).catch(() => {});
      }
      return flight;
    },
    async stop(bodyId) {
      const child = held.get(bodyId);
      if (child === undefined) return;
      held.delete(bodyId);
      killTree(child.pid);
      await child.exited;
    },
    get: (bodyId) => held.get(bodyId),
    failure: (bodyId) => failed.get(bodyId)?.why,
    list: () => [...held.values()],
    hold(bodyId) {
      busy.set(bodyId, (busy.get(bodyId) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = (busy.get(bodyId) ?? 1) - 1;
        if (left <= 0) busy.delete(bodyId);
        else busy.set(bodyId, left);
      };
    },
    touch(bodyId, now = Date.now()) {
      if (held.has(bodyId)) seen.set(bodyId, now);
    },
    async sleepIdle(idleMs, now = Date.now()) {
      const asleep: string[] = [];
      for (const child of [...held.values()]) {
        if (now - (seen.get(child.bodyId) ?? now) < idleMs || (busy.get(child.bodyId) ?? 0) > 0) continue;
        asleep.push(child.name);
        seen.delete(child.bodyId);
        await this.stop(child.bodyId);
      }
      return asleep;
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array> | number | null | undefined, log: (line: string) => void): Promise<void> {
  if (stream === null || stream === undefined || typeof stream === "number") return;
  const text = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of stream) {
      rest += text.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line !== "") log(line.slice(0, 500));
    }
  } catch {
    // the process is gone
  }
}

/** Stop every child cell this parent holds: when the parent stops, they go with it. */
export async function stopCellChildren(parent: App): Promise<void> {
  const r = registries.get(parent);
  if (r === undefined) return;
  registries.delete(parent);
  await Promise.all(r.list().map((c) => r.stop(c.bodyId)));
}

/** The cell placement: a body in the shared store, stopped when retired. */
export function cellPlacement(parent: App, store: BodyStore, maxChildren: () => number): Placement {
  const base = hostedPlacement({
    host: parentOrigin(parent.config),
    store,
    maxChildren,
    kind: "cell",
    newId: () => `${CELL_PREFIX}${crypto.randomUUID()}`,
  });
  return {
    ...(base.room === undefined ? {} : { room: base.room }),
    place: base.place,
    async retire(bodyId) {
      await cellChildren(parent).stop(bodyId);
      return base.retire(bodyId);
    },
  };
}

// ---- forwarding ----

/** Headers that say who the client is: the child believes them from its relay, so only the forge writes them. */
const WHO = new Set(["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-forwarded-host", "x-forwarded-proto"]);

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);

/** Carry a request to the child's loopback port and its answer back, streaming. */
export async function forward(
  child: Pick<CellChild, "port">,
  request: Request,
  clientHeader?: string,
): Promise<Response> {
  const at = new URL(request.url);
  const headers = new Headers();
  const named = clientHeader?.toLowerCase();
  for (const [k, v] of request.headers) if (!HOP.has(k) && !WHO.has(k) && k !== named) headers.set(k, v);
  // The address the forge resolved (`http/peer.ts`), the only one the child hears.
  headers.set("x-forwarded-for", clientAddress(request));
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    const res = await fetch(`http://127.0.0.1:${child.port}${at.pathname}${at.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: "manual",
      decompress: false,
    } as RequestInit);
    const out = new Headers();
    for (const [k, v] of res.headers) if (!HOP.has(k)) out.append(k, v);
    return new Response(res.body, { status: res.status, headers: out });
  } catch {
    return new Response("this forge is not answering", { status: 502 });
  }
}

/**
 * Carry a websocket handshake to the child's loopback port: the child's side
 * is opened first, and only then is the visitor's answered, as `proxyApp`
 * does for an app (`apps/proxy.ts`). Frames then go through `appWebSocket`,
 * the forge's one pump. `undefined` means the request became a socket.
 */
export async function forwardSocket(
  child: Pick<CellChild, "port">,
  request: Request,
  server: Bun.Server<AppSocket>,
  db: AppSocket["db"],
  clientHeader?: string,
): Promise<Response | undefined> {
  const at = new URL(request.url);
  const headers: Record<string, string> = {};
  const named = clientHeader?.toLowerCase();
  for (const [k, v] of request.headers) {
    // The client writes its own handshake; the visitor's key, version and extensions end here.
    if (!HOP.has(k) && !WHO.has(k) && k !== named && !k.startsWith("sec-websocket-")) headers[k] = v;
  }
  headers["x-forwarded-for"] = clientAddress(request);
  const url = new URL(`ws://127.0.0.1:${child.port}${at.pathname}${at.search}`);
  const opened = await connectUpstream(url, headers, offeredProtocols(request));
  if (!opened.ok) return new Response("this forge is not answering", { status: 502 });
  const upstream = opened.value;
  const upgraded = server.upgrade(request, {
    data: { upstream, userId: undefined, db, port: child.port },
    ...(upstream.protocol === "" ? {} : { headers: { "sec-websocket-protocol": upstream.protocol } }),
  });
  if (upgraded) return undefined;
  upstream.close(1000);
  return new Response("bad websocket handshake", { status: 400 });
}
