/**
 * The maintenance page, served from somewhere that stays up (the droplet):
 * `bun scripts/standby.ts [port]` answers every request with the calm page
 * and a 503, so a tunnel or Cloudflare origin pointed here shows visitors
 * "back soon", not an error. MAINTENANCE_REASON and MAINTENANCE_SINCE are
 * optional. Zero dependencies; reads no forge data.
 */
import { MAINTENANCE_HEADERS, maintenanceHtml } from "../src/maintenance/page.ts";

const port = Number(process.argv[2] ?? process.env["PORT"] ?? 8080);
const body = maintenanceHtml({
  ...(process.env["MAINTENANCE_REASON"] ? { reason: process.env["MAINTENANCE_REASON"] } : {}),
  ...(process.env["MAINTENANCE_SINCE"] ? { since: process.env["MAINTENANCE_SINCE"] } : {}),
});

Bun.serve({
  port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("standby", { status: 200 });
    return new Response(req.method === "HEAD" ? null : body, { status: 503, headers: MAINTENANCE_HEADERS });
  },
});
console.log(`standby maintenance page on :${port}`);
