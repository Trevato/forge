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

export interface EgressPolicy {
  /** Host names from `forge.json` `egress`: exact, or `*.example.com`. */
  readonly hosts: readonly string[];
  /** Origins always reachable, at exactly this host and port (the forge). */
  readonly origins: readonly { host: string; port: number }[];
}

export interface Egress {
  close(): void;
}

const HEAD_MAX = 16 * 1024;

/** A host name is allowed by the declared list (`*.x` matches below `x`). */
export function hostAllowed(hosts: readonly string[], host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return hosts.some((entry) => {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith("*.")) return name.endsWith(allowed.slice(1));
    return name === allowed;
  });
}

/** Whether an address is on the public internet (not this machine, not a private network). */
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

type Verdict = { ok: true; address: string } | { ok: false; why: string };

async function decide(
  policy: EgressPolicy,
  host: string,
  port: number,
): Promise<Verdict> {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const origin = policy.origins.some(
    (o) => o.host.toLowerCase() === name && o.port === port,
  );
  if (!origin && !hostAllowed(policy.hosts, name))
    return {
      ok: false,
      why: `${name} is not in this repository's egress (forge.json "egress")`,
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
  if (!origin && !addresses.every(isPublicAddress))
    return { ok: false, why: `${name} resolves to a private address` };
  return { ok: true, address: first };
}

interface Conn {
  head: Uint8Array;
  peer: Socket<undefined> | undefined;
  toPeer: Uint8Array[];
  toClient: Uint8Array[];
  done: boolean;
}

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
  try {
    const peer = await Bun.connect<undefined>({
      hostname: verdict.address,
      port,
      socket: {
        data(_peer, chunk) {
          if (!client.data.done) send(client, client.data.toClient, chunk);
        },
        drain(peer) {
          flush(peer, client.data.toPeer);
        },
        close() {
          if (!client.data.done) {
            client.data.done = true;
            client.end();
          }
        },
        error() {
          if (!client.data.done) {
            client.data.done = true;
            client.end();
          }
        },
      },
    });
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
    if (first.length > 0) send(peer, client.data.toPeer, first);
  } catch {
    refuse(client, "502 Bad Gateway", `${host}:${port} did not answer`);
  }
}

/** Listen at `path` and forward only what `policy` allows. */
export function startEgress(
  path: string,
  policy: EgressPolicy,
  log: (line: string) => void = () => {},
): Egress {
  const server = Bun.listen<Conn>({
    unix: path,
    socket: {
      open(client) {
        client.data = {
          head: new Uint8Array(0),
          peer: undefined,
          toPeer: [],
          toClient: [],
          done: false,
        };
      },
      data(client, chunk) {
        const conn = client.data;
        if (conn.peer !== undefined) {
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
      drain(client) {
        flush(client, client.data.toClient);
      },
      close(client) {
        client.data.done = true;
        client.data.peer?.end();
      },
      error(client) {
        client.data.done = true;
        client.data.peer?.end();
      },
    },
  });
  return { close: () => server.stop(true) };
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
      client.data.peer?.end();
    },
    error(client: Socket<Pair>) {
      client.data.done = true;
      client.data.peer?.end();
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
