/**
 * The vitals are gathered once for every surface that asks within a few
 * seconds (a terminal refresh, a health read, the board's strip), and again
 * once the time is up; with reuse off (the suite's way) every ask gathers.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgeVitals, vitalsReuse } from "../src/actions/health.ts";

let dataDir = "";
let app: App;
const was = vitalsReuse.ms;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vreuse-"));
  app = createApp({ dataDir, port: 0 });
});

afterAll(async () => {
  vitalsReuse.ms = was;
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("asks within the reuse window share one gathering", async () => {
  vitalsReuse.ms = 0;
  expect(forgeVitals(app)).not.toBe(forgeVitals(app));
  vitalsReuse.ms = 60_000;
  const first = forgeVitals(app);
  expect(forgeVitals(app)).toBe(first);
  vitalsReuse.ms = 10;
  await Bun.sleep(30);
  expect(forgeVitals(app)).not.toBe(first);
});
