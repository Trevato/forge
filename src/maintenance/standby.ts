/**
 * Is the standby page answering? Before the admin powers off, the forge asks
 * the one URL in MAINTENANCE_STANDBY_URL (never one taken from a request)
 * whether it answers 503 with the maintenance page. Plain data out.
 */

import type { Status } from "./service.ts";

export const STANDBY_START = "No standby configured: on the droplet run `bun scripts/standby.ts 8080`, point the tunnel or Cloudflare origin at it, and set MAINTENANCE_STANDBY_URL to check it here.";
const TIMEOUT_MS = 2000;
const READ_MAX = 65536;

export interface Standby {
  readonly state: "unset" | "answering" | "not_answering";
  readonly says: string;
}

/** The configured URL when it is a plain http(s) URL, else undefined. */
export function standbyUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env["MAINTENANCE_STANDBY_URL"]?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** The body's first READ_MAX bytes: the stream is read until then and cancelled, never read whole. */
export async function readCapped(res: Response, max: number = READ_MAX): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let have = 0;
  try {
    while (have < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.length > max - have ? value.subarray(0, max - have) : value;
      chunks.push(part);
      have += part.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function probeNow(url: string): Promise<Standby> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/html" } });
    const text = await readCapped(res);
    if (res.status !== 503) return { state: "not_answering", says: `Standby not answering: ${url} replied ${res.status}, not 503.` };
    if (!text.includes("Back soon")) return { state: "not_answering", says: `Standby not answering: ${url} replied 503 but not with the maintenance page.` };
    return { state: "answering", says: `Standby answering: ${url} serves the maintenance page with 503.` };
  } catch {
    return { state: "not_answering", says: `Standby not answering: ${url} did not reply within ${TIMEOUT_MS / 1000} s.` };
  }
}

const CACHE_MS = 5000;
let cached: { readonly url: string; readonly at: number; readonly result: Promise<Standby> } | undefined;

/** Forget the last answer (tests). */
export function forgetStandby(): void {
  cached = undefined;
}

/** The standby's state; one live probe per URL every few seconds, so views cannot hammer it. */
export function probeStandby(url: string | undefined = standbyUrl()): Promise<Standby> {
  if (url === undefined) return Promise.resolve({ state: "unset", says: STANDBY_START });
  const now = Date.now();
  if (cached && cached.url === url && now - cached.at < CACHE_MS) return cached.result;
  const result = probeNow(url);
  cached = { url, at: now, result };
  return result;
}

/** A status with a known standby beside it; "ready" says whether visitors will see the page. */
export function withStandby(s: Status, standby: Standby): Status & { readonly standby: Standby } {
  if (s.phase !== "ready") return { ...s, standby };
  const lead = standby.state === "answering" ? "Ready, standby answering" : standby.state === "unset" ? "Ready, no standby" : "Ready, standby not answering";
  return { ...s, standby, says: `${lead}: ${s.says.replace(/^Ready: /, "")}` };
}

export async function statusWithStandby(s: Status, probe: () => Promise<Standby> = probeStandby): Promise<Status & { readonly standby: Standby }> {
  return withStandby(s, await probe());
}
