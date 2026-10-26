/** `/signin` and `/signup` name session, each read and render in Server-Timing, and answer within budget (#4106). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { baselineMs, expectBudget } from "./helpers/budget.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-signin-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const PAGES: [string, string[]][] = [
  ["/signin", ["session", "settings", "claim", "render"]],
  ["/signup", ["session", "signup", "users", "claim", "render"]],
];

for (const [path, names] of PAGES)
  test(`GET ${path} names its phases and answers within its budget`, async () => {
    const against = await baselineMs(servers.url);
    await (await fetch(`${servers.url}${path}`)).text(); // warm
    // A loaded machine stalls the event loop mid-request and inflates any one
    // sample; the fastest of a few is what the handler itself costs.
    let best = Infinity;
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${servers.url}${path}`);
      await res.text();
      expect(res.status).toBe(200);
      const parts = (res.headers.get("server-timing") ?? "").split(", ");
      for (const name of ["app", ...names])
        expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
      const app = parts.find((p) => p.startsWith("app;"))!;
      best = Math.min(best, Number(app.slice("app;dur=".length)));
    }
    expectBudget(best, { ms: 10, against });
  });
