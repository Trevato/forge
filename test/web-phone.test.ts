/**
 * The page never scrolls sideways, on a phone.
 *
 * The topbar's tools are the width budget: none of them may push the page
 * wider than the viewport at 360px. `test/web-ui.test.ts` and friends check
 * the markup and the CSS text; this drives a real, headless Chromium so the
 * property is held here rather than trusted from the source.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { quietLogs } from "./helpers/globals.ts";
import { chromiumRuns, measurePageWidth } from "./helpers/chrome.ts";

quietLogs();

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) {
  console.log(
    "SKIPPING: no chromium that starts on this machine, so the phone-width test cannot run",
  );
}

describe.skipIf(chromium === undefined)(
  "the page never scrolls sideways, on a phone",
  () => {
    let dataDir: string;
    let app: App;
    let servers: Servers;
    let base: string;
    let cookie = { name: "", value: "" };

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "forge-phone-"));
      app = createApp({ dataDir, port: 0 });
      servers = await serve(app);
      base = servers.url;
      const signup = await fetch(`${base}/signup`, {
        method: "POST",
        body: new URLSearchParams({
          username: "ada",
          email: "ada@forge.local",
          password: "a-long-web-passphrase",
        }),
        redirect: "manual",
      });
      const set = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
      const [name, value] = set.split("=");
      cookie = { name: name!, value: value! };
    }, 20_000);

    afterAll(async () => {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    test("the studio's app list fits a 360px viewport: no element wider than it, no horizontal scroll", async () => {
      const page = await measurePageWidth(
        chromium!,
        `${base}/apps`,
        { width: 360, height: 800 },
        cookie,
      );
      expect(page.overflowing).toEqual([]);
      expect(page.scrollWidth).toBeLessThanOrEqual(page.viewportWidth);
    }, 20_000);
  },
);
