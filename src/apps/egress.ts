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
import { neverGrantable, PAYMENT_HOSTS } from "../core/egress_grants.ts";
import { during } from "../perf/jobs.ts";

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
   * Set while egress is only reported (`cells.egress` = `report`, an admin's setting): an
   * undeclared public host is let through and handed here instead of
   * refused. Private addresses are refused either way.
   */
  readonly report?: ((host: string, port: number) => void) | undefined;
  /** Whose proxy this is (`app:<slug>/<env>`), for the connection gauges. */
  readonly label?: string | undefined;
  /** More `egress` entries, asked on every connection: what an owner allowed since the cell started (#10456). */
  readonly allowed?: (() => readonly string[]) | undefined;
  /** Told of every connection refused by policy (not one that merely failed), with whether the destination is private. */
  readonly refused?: ((host: string, port: number, isPrivate: boolean) => void) | undefined;
  /** Most connections open to one destination at once; default 8. */
  readonly maxPerDestination?: number | undefined;
  /** Close a connection that moved no bytes for this long; default 5 min. */
  readonly idleMs?: number | undefined;
  /** Bytes held for a client that does not read before it is cut; default 4 MiB. */
  readonly queueMax?: number | undefined;
  /**
   * The proxy of the cell this forge itself runs in (`upstreamProxy`): a
   * child forge's cell has no route but that, so a cell the child opens
   * dials through it with `CONNECT`, and that proxy's own policy applies
   * on top of this one. Names are resolved there, not here (here nothing
   * resolves).
   */
  readonly upstream?: { readonly host: string; readonly port: number } | undefined;
}

/**
 * The proxy this forge's own cell set (`apps/contain.ts`): an `http:` URL on
 * loopback, or undefined where the forge runs in no cell.
 */
export function upstreamProxy(env: Record<string, string | undefined> = process.env): EgressPolicy["upstream"] {
  const raw = env["HTTPS_PROXY"] ?? env["https_proxy"];
  if (raw === undefined || raw === "") return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.username !== "") return undefined;
    return { host: url.hostname, port: Number(url.port) };
  } catch {
    return undefined;
  }
}

export interface Egress {
  close(): void;
}

const HEAD_MAX = 16 * 1024;
const MAX_PER_DESTINATION = 8;
/** A public destination's cap: an install opens dozens of parallel fetches to one registry. */
export const MAX_PER_PUBLIC_DESTINATION = 64;
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

/**
 * Bytes moved since the forge started, per destination alone (#7546): the
 * counters `/metrics` serves, and a minute-by-minute ring of the last hour,
 * so a cold bun cache shows as registry bytes without a packet capture.
 * Keyed by `host:port` and never by run label, so it holds one entry per
 * host the apps reach, not one per run; past `MOVED_MAX` destinations the
 * rest are counted under `other`, save the registry, which always keeps its
 * own entry so the headline figure is never lost there.
 */
interface Moved {
  bytesIn: number;
  bytesOut: number;
  /** Minute `m` (ms since epoch / 60 000) lands in slot `m % 60`. */
  readonly minute: number[];
  readonly minuteIn: number[];
}

const MOVED_MAX = 256;
const HOUR_MINUTES = 60;
const moved = new Map<string, Moved>();
/**
 * label -> bytes in, for the labels someone is metering now (`meterEgress`),
 * and the repository whose cell the label is: the one thing that says whose
 * registry bytes these are (#8382), set by the caller that opened the cell.
 */
const meters = new Map<string, { bytesIn: number; npmIn: number; holders: number; repoId: string | undefined }>();
/**
 * Registry bytes per repository, minute by minute over the last hour
 * (#8382). Only a metered install with a repository lands here; past
 * `NPM_REPOS_MAX` repositories the quietest is dropped first.
 */
const npmByRepo = new Map<string, Moved>();
const NPM_REPOS_MAX = 256;

function ring(): Moved {
  return { bytesIn: 0, bytesOut: 0, minute: Array(HOUR_MINUTES).fill(-1), minuteIn: Array(HOUR_MINUTES).fill(0) };
}

/** Add `bytesIn` to `m` at minute `minute`. */
function addMinute(m: Moved, minute: number, bytesIn: number): void {
  const slot = minute % HOUR_MINUTES;
  if (m.minute[slot] !== minute) {
    m.minute[slot] = minute;
    m.minuteIn[slot] = 0;
  }
  m.minuteIn[slot] = (m.minuteIn[slot] ?? 0) + bytesIn;
}

function recordNpmRepo(repoId: string, bytesIn: number, minute: number): void {
  let m = npmByRepo.get(repoId);
  if (m === undefined) {
    if (npmByRepo.size >= NPM_REPOS_MAX) {
      let quietest: string | undefined;
      let least = Infinity;
      for (const [id, r] of npmByRepo) {
        const hour = lastHour(r, minute);
        if (hour < least) [quietest, least] = [id, hour];
      }
      if (quietest !== undefined) npmByRepo.delete(quietest);
    }
    npmByRepo.set(repoId, (m = ring()));
  }
  m.bytesIn += bytesIn;
  addMinute(m, minute, bytesIn);
}

/** Count `bytesIn` received from and `bytesOut` sent to `destination`. */
export function recordEgress(
  label: string,
  destination: string,
  bytesIn: number,
  bytesOut: number,
  now = Date.now(),
): void {
  const key =
    destination === NPM_REGISTRY || moved.has(destination) || moved.size < MOVED_MAX
      ? destination
      : "other";
  let m = moved.get(key);
  if (m === undefined) moved.set(key, (m = ring()));
  m.bytesIn += bytesIn;
  m.bytesOut += bytesOut;
  const minute = Math.floor(now / 60_000);
  addMinute(m, minute, bytesIn);
  const meter = meters.get(label);
  if (meter === undefined) return;
  meter.bytesIn += bytesIn;
  if (destination !== NPM_REGISTRY || bytesIn === 0) return;
  meter.npmIn += bytesIn;
  if (meter.repoId !== undefined) recordNpmRepo(meter.repoId, bytesIn, minute);
}

export interface EgressTotal {
  readonly destination: string;
  /** Bytes received from it since the forge started. */
  readonly bytesIn: number;
  /** Bytes sent to it since the forge started. */
  readonly bytesOut: number;
  /** Bytes received from it in the 60 minutes up to `now`, this minute included. */
  readonly bytesInLastHour: number;
}

/** Bytes `m` received in the 60 minutes up to `minute`, that minute included. */
function lastHour(m: Moved, minute: number): number {
  let hour = 0;
  for (let i = 0; i < HOUR_MINUTES; i++) {
    const at = m.minute[i] ?? -1;
    if (at > minute - HOUR_MINUTES && at <= minute) hour += m.minuteIn[i] ?? 0;
  }
  return hour;
}

/** Every destination reached since the forge started, most received this hour first. */
export function egressTotals(now = Date.now()): EgressTotal[] {
  const minute = Math.floor(now / 60_000);
  const rows: EgressTotal[] = [];
  for (const [destination, m] of moved)
    rows.push({ destination, bytesIn: m.bytesIn, bytesOut: m.bytesOut, bytesInLastHour: lastHour(m, minute) });
  return rows.sort((a, b) => b.bytesInLastHour - a.bytesInLastHour || a.destination.localeCompare(b.destination));
}

/** The package registry every install step reaches (`apps/contain.ts` STEP_HOSTS). */
export const NPM_REGISTRY = "registry.npmjs.org:443";

/** Bytes received from the npm registry over the last hour, across every app and check. */
export function npmBytesLastHour(now = Date.now()): number {
  const m = moved.get(NPM_REGISTRY);
  return m === undefined ? 0 : lastHour(m, Math.floor(now / 60_000));
}

/** The repository that received most from the npm registry over the last hour, by id. */
export interface NpmTopRepo {
  readonly repoId: string;
  readonly bytes: number;
}

/** The metered repository the registry sent most to in the last hour; none when no metered install fetched. */
export function npmTopRepoLastHour(now = Date.now()): NpmTopRepo | undefined {
  const minute = Math.floor(now / 60_000);
  let top: NpmTopRepo | undefined;
  for (const [repoId, m] of npmByRepo) {
    const bytes = lastHour(m, minute);
    if (bytes > 0 && (top === undefined || bytes > top.bytes || (bytes === top.bytes && repoId < top.repoId)))
      top = { repoId, bytes };
  }
  return top;
}

export interface EgressMeter {
  /** Stop counting; answers the bytes received from every destination. */
  stop(): number;
  /** Bytes received from the npm registry alone, up to `stop()`. */
  npm(): number;
}

/**
 * Count what `label`'s proxy receives from now until `stop()`, which answers
 * the bytes in. Only labels being metered are kept, and each goes with its
 * last holder, so a run label never outlives the step that asked. `repoId`
 * is the repository whose cell `label` names, from the caller that opened
 * it: the registry bytes are attributed to it, never to anything the
 * install printed.
 */
export function meterEgress(label: string, repoId?: string): EgressMeter {
  const meter = meters.get(label) ?? { bytesIn: 0, npmIn: 0, holders: 0, repoId };
  // An earlier holder that knew no repository must not lose a later one's.
  meter.repoId ??= repoId;
  meters.set(label, meter);
  meter.holders++;
  const start = meter.bytesIn;
  const npmStart = meter.npmIn;
  let stopped: { bytes: number; npm: number } | undefined;
  return {
    stop() {
      if (stopped === undefined) {
        stopped = { bytes: meter.bytesIn - start, npm: meter.npmIn - npmStart };
        if (--meter.holders === 0) meters.delete(label);
      }
      return stopped.bytes;
    },
    npm() {
      return stopped?.npm ?? meter.npmIn - npmStart;
    },
  };
}

/** For tests: forget every cumulative count. */
export function resetEgressTotals(): void {
  moved.clear();
  npmByRepo.clear();
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
  | { ok: false; why: string; policy?: { private: boolean } };

export async function decide(
  policy: EgressPolicy,
  host: string,
  port: number,
): Promise<Verdict> {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const origin = policy.origins.some(
    (o) => o.host.toLowerCase() === name && o.port === port,
  );
  const declared = origin || hostAllowed([...policy.hosts, ...(policy.allowed?.() ?? [])], name, port);
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
  if (!declared && literalPrivate) return { ok: false, why: askAdmin, policy: { private: true } };
  // A payment host is never let through by report mode: only an app that
  // names it reaches it, whatever the admin's setting (#11142).
  const payment = PAYMENT_HOSTS.includes(`${name}:${port}`);
  if (!declared && (policy.report === undefined || payment || !WEB_PORTS.includes(port)))
    return {
      ok: false,
      why: `${name}:${port} is not in this repository's egress (forge.json "egress")`,
      policy: { private: false },
    };
  // Inside a cell, the cell's proxy resolves and checks the name itself.
  if (policy.upstream !== undefined) return { ok: true, address: name, undeclared: !declared };
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
        policy: { private: true },
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
  /** Whose proxy and where to, once dialled, for the cumulative counts. */
  label: string;
  destination?: string;
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
    if (verdict.policy !== undefined) policy.refused?.(host.toLowerCase(), port, verdict.policy.private);
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
  // The cap guards a granted private device (a Pi's camera, #3719); a public host such as the package
  // registry is reached by many parallel requests from one install, so it gets the wider cap.
  const cap = policy.maxPerDestination ?? (policy.upstream !== undefined || isPublicAddress(verdict.address) ? MAX_PER_PUBLIC_DESTINATION : MAX_PER_DESTINATION);
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
  client.data.destination = destination;
  client.data.release = () => untally(label, destination);
  const ended = () => {
    if (!client.data.done) {
      drop(client);
      client.end();
    }
  };
  const upstream = policy.upstream;
  // Through the cell's own proxy, its answer to `CONNECT` comes first; until
  // it says 200 nothing reaches the client, and anything else refuses it.
  let answer: Uint8Array | undefined = upstream === undefined ? undefined : new Uint8Array(0);
  let established = (): void => {};
  try {
    const peer = await Bun.connect<undefined>({
      hostname: upstream?.host ?? verdict.address,
      port: upstream?.port ?? port,
      socket: {
        data(peer, got) {
          if (client.data.done) {
            // Gone while the cell's proxy was still answering: nothing holds this end.
            if (answer !== undefined) peer.terminate();
            return;
          }
          let chunk: Uint8Array = got;
          if (answer !== undefined) {
            answer = concat(answer, chunk);
            const at = headEnd(answer);
            if (at === -1) {
              if (answer.length > HEAD_MAX) peer.terminate();
              return;
            }
            const status = decoder.decode(answer.subarray(0, at)).split("\r\n")[0] ?? "";
            const rest = answer.subarray(at);
            answer = undefined;
            if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
              log(`egress refused upstream: ${destination} ${status}`);
              client.data.release?.();
              client.data.release = undefined;
              refuse(client, "403 Forbidden", `${destination} is not reachable from this forge's cell (${status.slice(9, 80)})`);
              peer.terminate();
              return;
            }
            established();
            if (rest.length === 0) return;
            chunk = rest;
          }
          client.data.last = Date.now();
          count.bytesIn += chunk.length;
          recordEgress(label, destination, chunk.length, 0);
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
    established = () => {
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
        recordEgress(label, destination, 0, first.length);
        send(peer, client.data.toPeer, first);
      }
    };
    if (upstream === undefined) established();
    else peer.write(encoder.encode(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`));
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
        label: policy.label ?? "",
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
        if (conn.destination !== undefined) recordEgress(conn.label, conn.destination, 0, chunk.length);
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
    () => during("egress-idle", () => {
      const now = Date.now();
      for (const client of live)
        if (now - client.data.last > idleMs) {
          log(`egress idle: closed a connection quiet for ${idleMs} ms`);
          drop(client);
          client.terminate();
          live.delete(client);
        }
    }),
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
