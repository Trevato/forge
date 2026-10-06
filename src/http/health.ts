/**
 * What the forge says about itself to whatever keeps it running. `/healthz`
 * is the readiness answer: 200 while the forge takes new work, 503 once it
 * is draining — a release's old process, finishing what it holds while the
 * new one takes everything new. Liveness is the landing page, which keeps
 * answering through a drain; a draining forge is alive on purpose.
 */

export const health = { draining: false };

export function healthResponse(): Response {
  return health.draining
    ? new Response("draining", { status: 503 })
    : new Response("ok", { status: 200 });
}
