/**
 * What the forge says about itself to whatever keeps it running. `/healthz`
 * is the readiness answer: 200 while the forge takes new work, 503 once it
 * is draining — a release's old process, finishing what it holds while the
 * new one takes everything new. Liveness is the landing page, which keeps
 * answering through a drain; a draining forge is alive on purpose.
 */

export const health = { draining: false };

/**
 * `notes` are said after the status, one per line, while something an
 * operator must not forget is on — egress only reported, not enforced
 * (`core/capacity.ts`). The status line itself stays `ok` or `draining`.
 */
export function healthResponse(notes: readonly string[] = []): Response {
  const extra = notes.map((n) => `\n${n}`).join("");
  return health.draining
    ? new Response(`draining${extra}`, { status: 503 })
    : new Response(`ok${extra}`, { status: 200 });
}

/** What every new cell may reach while egress is only reported. */
export const EGRESS_REPORTED =
  "egress: reported, not enforced: every new app, preview, terminal and check cell may reach any public host on ports 80 and 443";
