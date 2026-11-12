/**
 * Loading looks right in Chrome (#11624). Pages opened by navigation in a
 * real Chromium, the "Waking up" page and its own refresh among them: the
 * page itself never cross-fades (that fade, run on every self-reload, was a
 * second indicator over the first), at most one indicator shows at a time, it
 * ends, and the layout does not shift past the budget. No live swap: the
 * only one that moves a card is a 1.1 s background flash that cannot repeat.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { wakingResponse } from "../src/web/pages/waking.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, observeNavigations } from "./helpers/chrome.ts";

const SHIFT_BUDGET = 0.1;
let dir: string;
let app: App;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-loading-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error("no user");
  token = createSession(app.db, made.value.id).token;
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts on this machine, so loading is not watched");

describe.skipIf(chromium === undefined)("loading, watched in Chromium", () => {
  test("the home, the waking page and its own reload: one indicator at a time, it ends, no fade, no shift", async () => {
    // The sleeping forge's page, served on the app's own origin so it takes the app's stylesheet.
    const front = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/__waking") return wakingResponse(app, request, "demo");
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.set("accept-encoding", "identity");
        const upstream = await fetch(servers.url + url.pathname + url.search, { headers, redirect: "manual" });
        const out = new Headers(upstream.headers);
        for (const h of ["content-encoding", "content-length", "transfer-encoding"]) out.delete(h);
        return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
      },
    });
    try {
      const base = `http://127.0.0.1:${front.port}`;
      const seen = await observeNavigations(
        chromium!,
        [
          { url: `${base}/` },
          { url: `${base}/explore` },
          { url: `${base}/__waking` },
          // Past its 3 s refresh: the page asking again by itself.
          { url: `${base}/__waking?again=1`, settleMs: 4_500 },
        ],
        { name: "forge_session", value: token },
      );
      for (const s of seen) {
        expect(s.rootAnimations).toBe(0);
        expect(s.mostIndicators).toBeLessThanOrEqual(1);
        expect(s.leftOver).toBe(0);
        expect(s.shift).toBeLessThanOrEqual(SHIFT_BUDGET);
      }
    } finally {
      front.stop(true);
    }
  }, 60_000);
});
