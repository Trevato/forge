/**
 * The one door a cell child has to its parent: a loopback listener that
 * answers `POST /api/v1/heartbeat`, `POST /api/v1/broker/origins` (a signed ask to
 * broker an origin sign-in, `spawn/origin_broker.ts`), and the lent model endpoint
 * (`spawn/model_door.ts`: `POST /v1/messages`, `GET /api/v1/credit`), and nothing else. The child's cell relays
 * only this port in, so untrusted child code never reaches the parent's web
 * surface, and since the door never asks who the client is, no forwarding
 * header it sends counts for anything.
 */

import type { App } from "../app.ts";
import { securityFloor } from "../http/respond.ts";
import { readCapped } from "./bounded_read.ts";
import { beatAnswer, receiveBeat, SIGNATURE_HEADER } from "./heartbeat.ts";
import { answerBrokerCall, CALL_BODY_MAX } from "./origin_broker.ts";
import { BROKER_CALL } from "./origin_broker_wire.ts";
import { creditAnswer, lendModel, MODEL_BODY_MAX, type ModelDeps } from "./model_door.ts";

const MAX_BODY = 1024;

/** Where a child reaches its parent's door from inside its cell. */
export const parentLocal = (port: number): string => `http://127.0.0.1:${port}`;

/** `FORGE_PARENT_LOCAL` as `parentLocal` writes it, and nothing else. */
export const isParentLocal = (value: string): boolean => /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value);

export interface BeatDoor {
  readonly port: number;
  close(): void;
}

export function openBeatDoor(app: App, deps: { readonly model?: ModelDeps } = {}): BeatDoor {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // Bun holds one limit per listener, and the model route needs the larger; each route counts the bytes it reads (`readCapped`).
    maxRequestBodySize: MODEL_BODY_MAX,
    // The security floor on every answer, like the forge's own door (#10949).
    fetch: async (req) => securityFloor(await answerBeat(app, deps, req)),
  });
  return { port: server.port!, close: () => server.stop(true) };
}

async function answerBeat(app: App, deps: { readonly model?: ModelDeps }, req: Request): Promise<Response> {
  const refused = new Response("no such door", { status: 404 });
  const path = new URL(req.url).pathname;
  if (req.method === "POST" && path === "/v1/messages") return lendModel(app, req, deps.model);
  if (req.method === "GET" && path === "/api/v1/credit") return creditAnswer(app, req);
  if (req.method === "POST" && path === BROKER_CALL) {
    // A signed call to broker an origin sign-in, and small: no signature, no read.
    const shown = req.headers.get(SIGNATURE_HEADER);
    if (shown === null) return refused;
    const bytes = await readCapped(req, CALL_BODY_MAX);
    return bytes === undefined ? refused : answerBrokerCall(app, new TextDecoder().decode(bytes), shown);
  }
  if (req.method !== "POST" || path !== "/api/v1/heartbeat") return refused;
  // A beat is signed and small: no signature, no read; then at most MAX_BODY bytes, counted as they arrive.
  const signature = req.headers.get(SIGNATURE_HEADER);
  if (signature === null) return refused;
  const bytes = await readCapped(req, MAX_BODY);
  if (bytes === undefined) return refused;
  const raw = new TextDecoder().decode(bytes);
  const kept = await receiveBeat(app, raw, signature);
  return kept ? Response.json(await beatAnswer(app, raw)) : refused;
}
