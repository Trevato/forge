/**
 * A capture: for a short while, keep what it takes to tell one actor from
 * another across addresses. The only place a full visitor address is ever
 * held, and only in memory, so a restart ends it as an expiry does.
 *
 * Bounded in time (`CAPTURE_MS`) and size (`CAPTURE_MAX` requests), and
 * expires by itself: `current` returns null once it is over and its requests
 * are dropped. It keeps no cookie, authorization header or query string: of
 * the headers, only their names, and the handful of values that tell clients
 * apart. Only requests no one was signed in behind are kept; a signed-in
 * person's requests are not an investigation's business.
 */

import { addressBytes } from "../kernel/cidr.ts";
import { prefixOf, type TrafficClass } from "./traffic.ts";
import { readOf, type Read } from "./reads.ts";

export const CAPTURE_MS = 10 * 60_000;
export const CAPTURE_MAX = 2_000;

export interface CapturedRequest {
  readonly n: number;
  readonly at: number;
  readonly address: string;
  readonly prefix: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly ua: string;
  /** Header names (never values) except the ones a proxy adds, in the order received. */
  readonly shape: string;
  readonly language: string;
  readonly accept: string;
  readonly encoding: string;
  readonly fetchSite: string;
  readonly country: string | null;
  /** Cloudflare's bot score, 1 to 99, when the edge sent one. */
  readonly botScore: number | null;
  readonly read: Read | null;
}

export interface Capture {
  readonly id: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly by: string;
  readonly entries: readonly CapturedRequest[];
  /** The size bound was reached; later requests were not kept. */
  readonly full: boolean;
}

/** What the server tells a capture of one finished request. */
export interface CaptureInput {
  readonly request: Request;
  readonly address: string;
  /** Came through a trusted edge: only then are its bot score and country headers believed. */
  readonly viaEdge: boolean;
  readonly status: number;
  readonly ms: number;
  readonly cls: TrafficClass;
  readonly pattern: string;
}

const PROXY_HEADER = /^(x-forwarded-|cf-|x-real-ip$|cdn-loop$|traceparent$|tracestate$|x-request-id$|forwarded$|via$|x-envoy-|x-amzn-)/;
const NEVER = /^(cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/;

const short = (s: string | null, max: number): string =>
  // eslint-disable-next-line no-control-regex
  (s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);

/** The Cloudflare bot score a header carries (`cf-bot-score` or `x-bot-score`): a whole number from 1 to 99, else null. */
export function botScoreOf(headers: Headers): number | null {
  const raw = headers.get("cf-bot-score") ?? headers.get("x-bot-score");
  if (raw === null || !/^\d{1,2}$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 1 && n <= 99 ? n : null;
}

export function describe(input: CaptureInput, n: number, at: number): CapturedRequest {
  const { request: r } = input;
  const url = new URL(r.url);
  const bytes = addressBytes(input.address);
  const names = [...r.headers.keys()].filter((h) => !PROXY_HEADER.test(h) && !NEVER.test(h));
  const country = input.viaEdge ? (r.headers.get("cf-ipcountry")?.toUpperCase() ?? "") : "";
  return {
    n,
    at,
    address: bytes === undefined ? "unknown" : short(input.address, 45),
    prefix: bytes === undefined ? "unknown" : prefixOf(bytes),
    method: short(r.method, 8),
    // The query is left out: it can carry a token.
    path: short(url.pathname, 300),
    status: input.status,
    ms: Math.round(input.ms),
    ua: short(r.headers.get("user-agent"), 200),
    shape: names.slice(0, 30).join(","),
    language: short(r.headers.get("accept-language"), 60),
    accept: short(r.headers.get("accept"), 80),
    encoding: short(r.headers.get("accept-encoding"), 40),
    fetchSite: short(r.headers.get("sec-fetch-site"), 16),
    country: /^[A-Z][A-Z0-9]$/.test(country) ? country : null,
    botScore: input.viaEdge ? botScoreOf(r.headers) : null,
    read: readOf(input.pattern, url.pathname),
  };
}

export interface CaptureStore {
  /** Begin a capture; if one is running, that one. */
  start(now: number, by: string): Capture;
  stop(): void;
  /** The running capture, or null once it has expired (its requests are dropped then). */
  current(now: number): Capture | null;
  /** Cheap: is anything being kept at all. */
  active(now: number): boolean;
  note(now: number, input: CaptureInput): void;
}

export function createCaptureStore(): CaptureStore {
  let id = "";
  let startedAt = 0;
  let expiresAt = 0;
  let by = "";
  let entries: CapturedRequest[] = [];
  let full = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drop = (): void => {
    clearTimeout(timer);
    id = "";
    entries = [];
    full = false;
    expiresAt = 0;
  };
  const live = (now: number): boolean => {
    if (id !== "" && now >= expiresAt) drop();
    return id !== "";
  };
  return {
    start(now, who) {
      if (!live(now)) {
        id = crypto.randomUUID().slice(0, 8);
        startedAt = now;
        expiresAt = now + CAPTURE_MS;
        by = who;
        entries = [];
        full = false;
        timer = setTimeout(drop, CAPTURE_MS + 1_000);
        timer.unref();
      }
      return this.current(now)!;
    },
    stop: drop,
    current(now) {
      return live(now) ? { id, startedAt, expiresAt, by, entries, full } : null;
    },
    active: live,
    note(now, input) {
      if (!live(now) || input.cls === "people" || input.cls === "internal") return;
      if (new URL(input.request.url).pathname.startsWith("/settings/traffic")) return;
      if (entries.length >= CAPTURE_MAX) {
        full = true;
        return;
      }
      entries.push(describe(input, entries.length + 1, now));
    },
  };
}
