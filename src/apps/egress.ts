/**
 * The one way out of a contained process (`apps/contain.ts`): an HTTP proxy
 * on a Unix socket, bound into the process's own network namespace, which
 * has no other route anywhere. It forwards to a host the repository declared
 * in `forge.json` (`egress`), or to the forge itself, and refuses everything
 * else with a 403 that names the host.
 *
 * A declared name is not trusted to stay public: it is resolved here, and a
 * name that resolves to a private, loopback or link-local address (the
 * cluster, the node's metadata service, another pod) is refused unless it is
 * the forge's own origin. The connection goes to the address that was
 * checked, so the answer cannot change between the check and the dial.
 *
 * `CONNECT host:port` (what HTTPS clients send) is tunnelled; an
 * absolute-form request (`GET http://host/path`) is forwarded once with
 * `Connection: close`, so a kept-alive socket can never be pointed at a
 * second host the first answer did not cover.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Socket } from "bun";
import { neverGrantable } from "../core/egress_grants.ts";

export interface EgressPolicy {
  /** Host names from `forge.json` `egress`: exact, or `*.example.com`. */
  readonly hosts: readonly string[];
  /** Origins always reachable, at exactly this host and port (the forge). */
  readonly origins: readonly { host: string; port: number }[];
  /**
   * Private destinations a site admin granted this repository, `host:port`
   * (`core/egress_grants.ts`). One only opens when `hosts` also declares it.
   */
  readonly granted?: readonly string[] | undefined;
  /**
   * Set while egress is only reported (`FORGE_CELLS_EGRESS=report`): an
   * undeclared public host is let through and handed here instead of
   * refused. Private addresses are refused either way.
   */
  readonly report?: ((host: string, port: number) => void) | undefined;
  /** Whose proxy this is (`app:<slug>/<env>`), for the connection gauges. */
  readonly label?: string | undefined;
  /** Most connections open to one destination at once; default 8. */
  readonly maxPerDestination?: number | undefined;
  /** Close a connection that moved no bytes for this long; default 5 min. */
  readonly idleMs?: number | undefined;
  /** Bytes held for a client that does not read before it is cut; default 4 MiB. */
  readonly queueMax?: number | undefined;
}

export interface Egress {
  close(): void;
}

const HEAD_MAX = 16 * 1024;
const MAX_PER_DESTINATION = 8;
const IDLE_MS = 5 * 60_000;
/** Bytes held for a client that does not read before its upstream is cut. */
const QUEUE_MAX = 4 * 1024 * 1024;

interface Tally {
  open: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * label -> `host:port` -> counts, for the connections open right now. A
 * destination's entry goes when its last connection closes (and the label
 * with its last destination), so it only ever holds what is live.
 */
const tallies = new Map<string, Map<string, Tally>>();

function tally(label: string, destination: string): Tally {
  let byDestination = tallies.get(label);
  if (byDestination === undefined) tallies.set(label, (byDestination = new Map()));
  let t = byDestination.get(destination);
  if (t === undefined)
    byDestination.set(destination, (t = { open: 0, bytesIn: 0, bytesOut: 0 }));
  return t;
}

/** One connection closed: drop its destination, then its label, when empty. */
function untally(label: string, destination: string): void {
  const byDestination = tallies.get(label);
  const t = byDestination?.get(destination);
  if (byDestination === undefined || t === undefined) return;
  if (--t.open > 0) return;
  byDestination.delete(destination);
  if (byDestination.size === 0) tallies.delete(label);
}

export interface EgressRow {
  readonly label: string;
  readonly destination: string;
  readonly open: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

/** Every destination an app holds connections to now, busiest first. */
export function egressSnapshot(): EgressRow[] {
  const rows: EgressRow[] = [];
  for (const [label, byDestination] of tallies)
    for (const [destination, t] of byDestination)
      rows.push({ label, destination, open: t.open, bytesIn: t.bytesIn, bytesOut: t.bytesOut });
  return rows.sort((a, b) => b.open - a.open || a.label.localeCompare(b.label));
}

/** The ports a declared host may be reached on when its entry names none. */
export const WEB_PORTS: readonly number[] = [80, 443];

/**
 * A host and port are allowed by the declared list: `name` or `*.name`
 * (every name below it) on 80 and 443, or `name:port` on that port alone.
 */
export function hostAllowed(
  hosts: readonly string[],
  host: string,
  port: number,
): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return hosts.some((entry) => {
    const at = entry.lastIndexOf(":");
    const pattern = (at === -1 ? entry : entry.slice(0, at)).toLowerCase();
    const ports = at === -1 ? WEB_PORTS : [Number(entry.slice(at + 1))];
    if (!ports.includes(port)) return false;
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
    return name === pattern;
  });
}

/**
 * Whether an address is on the public internet (not this machine, not a
 * private network). Anything that is not an IP address at all is not: a
 * name is only ever checked here after it has been resolved.
 */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address;
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b < 128) return false; // shared address space
    if (a === 169 && b === 254) return false; // link-local, metadata
    if (a === 172 && b >= 16 && b < 32) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (/^f[cd]/.test(lower)) return false; // unique local
    if (/^fe[89ab]/.test(lower)) return false; // link-local
    if (lower.startsWith("ff")) return false; // multicast
    return true;
  }
  return false;
}

export type Verdict =
  | { ok: true; address: string; undeclared: boolean }
  | { ok: false; why: string };

export async function decide(
  policy: EgressPolicy,
  host: string,
  port: number,
): Promise<Verdict> {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const origin = policy.origins.some(
    (o) => o.host.toLowerCase() === name && o.port === port,
  );
  const declared = origin || hostAllowed(policy.hosts, name, port);
  const literalPrivate = isIP(name) !== 0 && !isPublicAddress(name);
  const askAdmin =
    `${name}:${port} is a private destination: ` +
    "add it to forge.json egress and ask a site admin to grant it";
  // A grant opens only a destination forge.json names exactly: a wildcard
  // entry declares names, it never makes one of them grantable.
  const granted =
    (policy.granted ?? []).includes(`${name}:${port}`) &&
    policy.hosts.some((h) => h.toLowerCase() === `${name}:${port}`);
  // Reporting lets an undeclared host through (and says so) on the web
  // ports alone; any other port, and any private address (below), is
  // refused in both modes.
  if (!declared && literalPrivate) return { ok: false, why: askAdmin };
  if (!declared && (policy.report === undefined || !WEB_PORTS.includes(port)))
    return {
      ok: false,
      why: `${name}:${port} is not in this repository's egress (forge.json "egress")`,
    };
  let addresses: string[];
  try {
    addresses = (await lookup(name, { all: true })).map((a) => a.address);
  } catch {
    return { ok: false, why: `${name} does not resolve` };
  }
  const first = addresses[0];
  if (first === undefined)
    return { ok: false, why: `${name} does not resolve` };
  if (!origin && !addresses.every(isPublicAddress)) {
    if (!granted)
      return {
        ok: false,
        why: literalPrivate
          ? askAdmin
          : `${name} resolves to a private address; add ${name}:${port} ` +
            "to forge.json egress and ask a site admin to grant it",
      };
    // A grant opens one destination, never the metadata service or the
    // forge's own cluster, whatever a name resolves to.
    if (addresses.some((a) => !isPublicAddress(a) && neverGrantable(a)))
      return {
        ok: false,
        why: `${name} resolves to an address that can never be granted`,
      };
  }
  return { ok: true, address: first, undeclared: !declared };
}

interface Conn {
  head: Uint8Array;
  peer: Socket<undefined> | undefined;
  toPeer: Uint8Array[];
  toClient: Uint8Array[];
  done: boolean;
  /** The destination's counts once dialled; the data path adds to it directly. */
  tally?: Tally;
  /** When bytes last moved either way (ms). */
  last: number;
  /** Frees the destination's slot and counts it closed; set once dialled. */
  release: (() => void) | undefined;
}

/** Cut both sides now: the upstream must never outlive the client. */
function drop(client: Socket<Conn>): void {
  const conn = client.data;
  conn.done = true;
  conn.release?.();
  conn.release = undefined;
  conn.peer?.terminate();
}

const queued = (queue: Uint8Array[]): number =>
  queue.reduce((n, c) => n + c.length, 0);

/** Write what the socket takes now; keep the rest for its `drain`. */
function send(
  socket: { write(data: Uint8Array): number },
  queue: Uint8Array[],
  chunk: Uint8Array,
): void {
  if (queue.length > 0) {
    queue.push(chunk);
    return;
  }
  const n = socket.write(chunk);
  if (n < chunk.length) queue.push(chunk.subarray(Math.max(n, 0)));
}

function flush(
  socket: { write(data: Uint8Array): number },
  queue: Uint8Array[],
): void {
  while (queue.length > 0) {
    const chunk = queue[0];
    if (chunk === undefined) break;
    const n = socket.write(chunk);
    if (n < chunk.length) {
      queue[0] = chunk.subarray(Math.max(n, 0));
      return;
    }
    queue.shift();
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function refuse(client: Socket<Conn>, status: string, why: string): void {
  client.data.done = true;
  client.end(
    encoder.encode(
      `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nX-Forge-Egress: refused\r\nConnection: close\r\nContent-Length: ${encoder.encode(why).length + 1}\r\n\r\n${why}\n`,
    ),
  );
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Index just past the blank line that ends the head, or -1. */
function headEnd(bytes: Uint8Array): number {
  for (let i = 3; i < bytes.length; i++)
    if (
      bytes[i] === 10 &&
      bytes[i - 1] === 13 &&
      bytes[i - 2] === 10 &&
      bytes[i - 3] === 13
    )
      return i + 1;
  return -1;
}

async function open(
  client: Socket<Conn>,
  policy: EgressPolicy,
  log: (line: string) => void,
): Promise<void> {
  const raw = client.data.head;
  const end = headEnd(raw);
  const head = decoder.decode(raw.subarray(0, end));
  const [requestLine = "", ...headers] = head.split("\r\n");
  const [method = "", target = "", version = "HTTP/1.1"] =
    requestLine.split(" ");
  let host: string;
  let port: number;
  // What goes upstream ahead of the bytes after the head: nothing for a
  // tunnel, the rewritten head for a forwarded request.
  let prefix = new Uint8Array(0);
  let tunnel = false;
  if (method.toUpperCase() === "CONNECT") {
    const at = target.lastIndexOf(":");
    host = target.slice(0, at);
    port = Number(target.slice(at + 1));
    tunnel = true;
  } else {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      refuse(
        client,
        "400 Bad Request",
        "the proxy takes absolute URLs or CONNECT",
      );
      return;
    }
    if (url.protocol !== "http:") {
      refuse(
        client,
        "400 Bad Request",
        "only http: is forwarded; use CONNECT for https",
      );
      return;
    }
    host = url.hostname;
    port = Number(url.port || 80);
    const kept = headers.filter(
      (h) => h !== "" && !/^(proxy-[a-z-]*|connection|keep-alive):/i.test(h),
    );
    prefix = encoder.encode(
      `${method} ${url.pathname}${url.search} ${version}\r\n${kept.join("\r\n")}\r\nConnection: close\r\n\r\n`,
    );
  }
  if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    refuse(client, "400 Bad Request", "no host to reach");
    return;
  }
  const verdict = await decide(policy, host, port);
  if (!verdict.ok) {
    log(`egress refused: ${verdict.why}`);
    refuse(client, "403 Forbidden", verdict.why);
    return;
  }
  if (client.data.done) return;
  if (verdict.undeclared) {
    log(`egress reported: ${host}:${port} is not in forge.json "egress" (let through while egress is only reported)`);
    policy.report?.(host.toLowerCase(), port);
  }
  const destination = `${host.toLowerCase()}:${port}`;
  const count = tally(policy.label ?? "", destination);
  const cap = policy.maxPerDestination ?? MAX_PER_DESTINATION;
  if (count.open >= cap) {
    log(`egress capped: ${policy.label ?? "app"} already has ${count.open} connections to ${destination}`);
    refuse(
      client,
      "429 Too Many Requests",
      `${destination} already has ${cap} open connections from this app`,
    );
    return;
  }
  // The slot is taken before the dial so a burst cannot all pass the check.
  count.open++;
  client.data.tally = count;
  const label = policy.label ?? "";
  client.data.release = () => untally(label, destination);
  const ended = () => {
    if (!client.data.done) {
      drop(client);
      client.end();
    }
  };
  try {
    const peer = await Bun.connect<undefined>({
      hostname: verdict.address,
      port,
      socket: {
        data(_peer, chunk) {
          if (client.data.done) return;
          client.data.last = Date.now();
          count.bytesIn += chunk.length;
          send(client, client.data.toClient, chunk);
          if (queued(client.data.toClient) > (policy.queueMax ?? QUEUE_MAX)) {
            drop(client);
            client.terminate();
          }
        },
        drain(peer) {
          flush(peer, client.data.toPeer);
        },
        close: ended,
        error: ended,
      },
    });
    // The client went away while the dial was in flight: nobody is left to
    // take this connection, so it must not stay open.
    if (client.data.done) {
      peer.terminate();
      client.data.release?.();
      client.data.release = undefined;
      return;
    }
    client.data.peer = peer;
    if (tunnel)
      send(
        client,
        client.data.toClient,
        encoder.encode("HTTP/1.1 200 Connection Established\r\n\r\n"),
      );
    // Everything after the head — including what arrived during the dial,
    // kept with it — goes out now; from here `data` forwards directly.
    const first = concat(prefix, client.data.head.subarray(end));
    if (first.length > 0) {
      count.bytesOut += first.length;
      send(peer, client.data.toPeer, first);
    }
  } catch {
    client.data.release?.();
    client.data.release = undefined;
    refuse(client, "502 Bad Gateway", `${host}:${port} did not answer`);
  }
}

/**
 * Listen at `path` and forward only what `policy` allows. `{ tcp }` (a
 * loopback port) exists for the tests, where a unix socket cannot be bound.
 */
export function startEgress(
  path: string | { tcp: number },
  policy: EgressPolicy,
  log: (line: string) => void = () => {},
): Egress {
  const live = new Set<Socket<Conn>>();
  const handlers = {
    open(client: Socket<Conn>) {
      live.add(client);
      client.data = {
        head: new Uint8Array(0),
        peer: undefined,
        toPeer: [],
        toClient: [],
        done: false,
        last: Date.now(),
        release: undefined,
      };
    },
    data(client: Socket<Conn>, chunk: Uint8Array) {
      const conn = client.data;
      conn.last = Date.now();
      if (conn.peer !== undefined) {
        if (conn.done) return;
        if (conn.tally !== undefined) conn.tally.bytesOut += chunk.length;
        send(conn.peer, conn.toPeer, chunk);
        return;
      }
      if (conn.done) return;
      const before = conn.head.length;
      conn.head = concat(conn.head, chunk);
      // Waiting on the upstream dial: whatever else arrives is kept with
      // the head, and goes out after it.
      if (before > 0 && headEnd(conn.head.subarray(0, before)) !== -1) return;
      if (headEnd(conn.head) === -1) {
        if (conn.head.length > HEAD_MAX)
          refuse(
            client,
            "431 Request Header Fields Too Large",
            "head too large",
          );
        return;
      }
      void open(client, policy, log);
    },
    drain(client: Socket<Conn>) {
      client.data.last = Date.now();
      flush(client, client.data.toClient);
    },
    close(client: Socket<Conn>) {
      live.delete(client);
      drop(client);
    },
    error(client: Socket<Conn>) {
      live.delete(client);
      drop(client);
    },
  };
  const server =
    typeof path === "string"
      ? Bun.listen<Conn>({ unix: path, socket: handlers })
      : Bun.listen<Conn>({ hostname: "127.0.0.1", port: path.tcp, socket: handlers });
  // A tunnel that moves nothing (a client that stopped reading, an upstream
  // that stopped sending) is cut, so it cannot hold an upstream open.
  const idleMs = policy.idleMs ?? IDLE_MS;
  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const client of live)
        if (now - client.data.last > idleMs) {
          log(`egress idle: closed a connection quiet for ${idleMs} ms`);
          drop(client);
          client.terminate();
          live.delete(client);
        }
    },
    Math.max(50, Math.min(5_000, idleMs / 2)),
  );
  sweep.unref();
  return {
    close() {
      clearInterval(sweep);
      for (const client of live) {
        drop(client);
        client.terminate();
      }
      live.clear();
      server.stop(true);
    },
  };
}

/**
 * Relay every TCP connection to `127.0.0.1:port` into the Unix socket at
 * `path`, byte for byte: how the forge reaches an app that listens inside
 * its own network namespace, and how a contained process reaches the
 * forge's own loopback port from inside one.
 */
export function relay(
  listen: { tcp: number } | { unix: string },
  target: { unix: string } | { tcp: number },
): Egress {
  interface Pair {
    peer: Socket<undefined> | undefined;
    early: Uint8Array[];
    toPeer: Uint8Array[];
    toClient: Uint8Array[];
    done: boolean;
  }
  const handlers = {
    open(client: Socket<Pair>) {
      const pair: Pair = {
        peer: undefined,
        early: [],
        toPeer: [],
        toClient: [],
        done: false,
      };
      client.data = pair;
      const dial =
        "unix" in target
          ? { unix: target.unix }
          : { hostname: "127.0.0.1", port: target.tcp };
      Bun.connect<undefined>({
        ...dial,
        socket: {
          data(_peer, chunk) {
            if (!pair.done) send(client, pair.toClient, chunk);
          },
          drain(peer) {
            flush(peer, pair.toPeer);
          },
          close() {
            if (!pair.done) {
              pair.done = true;
              client.end();
            }
          },
          error() {
            if (!pair.done) {
              pair.done = true;
              client.end();
            }
          },
        },
      } as Parameters<typeof Bun.connect<undefined>>[0]).then(
        (peer) => {
          if (pair.done) {
            peer.end();
            return;
          }
          pair.peer = peer;
          for (const chunk of pair.early) send(peer, pair.toPeer, chunk);
          pair.early = [];
        },
        () => {
          pair.done = true;
          client.end();
        },
      );
    },
    data(client: Socket<Pair>, chunk: Uint8Array) {
      const pair = client.data;
      if (pair.peer === undefined) pair.early.push(chunk);
      else send(pair.peer, pair.toPeer, chunk);
    },
    drain(client: Socket<Pair>) {
      flush(client, client.data.toClient);
    },
    close(client: Socket<Pair>) {
      client.data.done = true;
      client.data.peer?.terminate();
    },
    error(client: Socket<Pair>) {
      client.data.done = true;
      client.data.peer?.terminate();
    },
  };
  const server =
    "unix" in listen
      ? Bun.listen<Pair>({ unix: listen.unix, socket: handlers })
      : Bun.listen<Pair>({
          hostname: "127.0.0.1",
          port: listen.tcp,
          socket: handlers,
        });
  return { close: () => server.stop(true) };
}
