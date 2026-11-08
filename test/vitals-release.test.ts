/**
 * An unproven release is a `release` card pointing at the board, and a
 * later pass clears it (#2574). The terminal's first screen prints the same
 * cards (`forgeNeeds`), so it shows this one too.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { vitals } from "../src/kernel/vitals.ts";

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vitals-release-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const card = () =>
  vitals({ db: app.db, signals: app.signals, dataDir }).degraded.find((d) => d.cause === "release");
const keep = (proof: object) => {
  mkdirSync(join(dataDir, "release"), { recursive: true });
  writeFileSync(join(dataDir, "release", "proof.json"), JSON.stringify(proof));
};

test("no proof, no card", () => {
  expect(card()).toBeUndefined();
});

test("a failing proof is a release card naming the check, linking the board", () => {
  keep({ version: "9.9.9", at: "2026-10-18T10:00:00.000Z", ok: false, failure: "https://f/a.css expected 200 (status 500)" });
  expect(card()).toMatchObject({
    sentence: "Release 9.9.9 is unproven: https://f/a.css expected 200 (status 500). It is proven again at 10:05 UTC.",
    href: "/board",
    since: "2026-10-18T10:00:00.000Z",
  });
});

test("a passing proof clears it", () => {
  keep({ version: "9.9.10", at: "2026-10-18T11:00:00.000Z", ok: true });
  expect(card()).toBeUndefined();
});
