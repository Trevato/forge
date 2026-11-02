/**
 * The one door a cell child has to its parent: a loopback listener that
 * answers `POST /api/v1/heartbeat` and nothing else. The child's cell relays
 * only this port in, so untrusted child code never reaches the parent's web
 * surface, and since the door never asks who the client is, no forwarding
 * header it sends counts for anything.
 */

import type { App } from "../app.ts";
import { receiveBeat, SIGNATURE_HEADER } from "./heartbeat.ts";

const MAX_BODY = 1024;

/** Where a child reaches its parent's door from inside its cell. */
export const parentLocal = (port: number): string => `http://127.0.0.1:${port}`;

/** `FORGE_PARENT_LOCAL` as `parentLocal` writes it, and nothing else. */
export const isParentLocal = (value: string): boolean => /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value);

export interface BeatDoor {
  readonly port: number;
  close(): void;
}

export function openBeatDoor(app: App): BeatDoor {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: MAX_BODY,
    async fetch(req) {
      const refused = new Response("no such door", { status: 404 });
      if (req.method !== "POST" || new URL(req.url).pathname !== "/api/v1/heartbeat") return refused;
      const raw = await req.text();
      if (raw.length > MAX_BODY) return refused;
      const kept = await receiveBeat(app, raw, req.headers.get(SIGNATURE_HEADER));
      return kept ? Response.json({ ok: true }) : refused;
    },
  });
  return { port: server.port!, close: () => server.stop(true) };
}
