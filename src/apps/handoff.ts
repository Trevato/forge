/**
 * What the proxy has in flight to one deployment, by the loopback port it
 * listens on — so a deployment that is being replaced can be let go of
 * without dropping what it was doing (#4496).
 *
 * A request passed to a port is held until its answer begins; a proxied
 * websocket is held until it closes. `drainPort` is what happens to the
 * old deployment once the new one serves (its own deploy) or once the
 * forge that proxies it is leaving (a forge rollout): every socket on it
 * is closed with 1012 Service Restart — RFC 6455 §7.4.1 via the IANA
 * registry: "the server is restarting, a client may reconnect" — so a
 * browser reconnects at once, to whatever serves now; and the requests
 * still waiting on it are given up to the budget to be answered before
 * the process is stopped.
 *
 * Plain process memory, keyed by port: a port is unique among the live
 * deployments of one forge (`apps/process.ts` `freePort`).
 */

/** RFC 6455 close code 1012: the service is restarting; reconnect. */
export const SERVICE_RESTART = 1012;
export const SERVICE_RESTART_REASON = "service restart";

/** How long a replaced deployment keeps answering what it already took (#4496). */
export const DRAIN_BUDGET_MS = 30_000;
const POLL_MS = 25;

interface Held {
  requests: number;
  readonly sockets: Set<{ close(code: number, reason: string): void }>;
}

const ports = new Map<number, Held>();

function heldAt(port: number): Held {
  let held = ports.get(port);
  if (held === undefined) {
    held = { requests: 0, sockets: new Set() };
    ports.set(port, held);
  }
  return held;
}

function forget(port: number, held: Held): void {
  if (held.requests === 0 && held.sockets.size === 0 && ports.get(port) === held)
    ports.delete(port);
}

/** A request is on its way to `port`; the returned release is called once its answer begins. */
export function holdPortRequest(port: number): () => void {
  const held = heldAt(port);
  held.requests++;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    held.requests--;
    forget(port, held);
  };
}

/** A websocket through to `port` is open; the returned release is called when it closes. */
export function holdPortSocket(
  port: number,
  socket: { close(code: number, reason: string): void },
): () => void {
  const held = heldAt(port);
  held.sockets.add(socket);
  return () => {
    held.sockets.delete(socket);
    forget(port, held);
  };
}

/** What is in flight to `port` this instant. */
export function inFlight(port: number): { requests: number; sockets: number } {
  const held = ports.get(port);
  return { requests: held?.requests ?? 0, sockets: held?.sockets.size ?? 0 };
}

/**
 * Let go of the deployment on `port`: close its sockets with 1012, then wait
 * — at most `budgetMs` — for the requests it is still answering. Resolves
 * with how many requests were still waiting when it gave up (0 when all
 * were answered).
 */
export async function drainPort(port: number, budgetMs = DRAIN_BUDGET_MS): Promise<number> {
  const held = ports.get(port);
  if (held === undefined) return 0;
  for (const socket of [...held.sockets]) {
    try {
      socket.close(SERVICE_RESTART, SERVICE_RESTART_REASON);
    } catch {
      // Already closing: its own close handler releases it.
    }
  }
  const deadline = Date.now() + budgetMs;
  while (held.requests > 0 && Date.now() < deadline) await Bun.sleep(POLL_MS);
  return held.requests;
}
