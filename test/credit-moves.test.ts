/**
 * The included credit moves when a run spends (#11948): the host is asked at
 * the run's end, not only at the next heartbeat, and a run on lent credit is
 * budgeted no more than what is left of it, so the budget line and the credit
 * line are one figure.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { fundingOf, keepFunding, refreshFunding } from "../src/spawn/funding.ts";
import { crewNote } from "../src/web/studio/crew_key.ts";

let dir = "";
let child: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "credit-moves-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "parent.json"), "{}");
  child = createApp({ dataDir: dir, port: 0 });
  keepFunding(dir, { token: "maria.bearer-token", capUsd: 2, spentUsd: 0 });
  process.env["FORGE_PARENT_LOCAL"] = "http://127.0.0.1:1";
});
afterAll(async () => {
  delete process.env["FORGE_PARENT_LOCAL"];
  await rm(dir, { recursive: true, force: true });
});

test("the credit line moves after the host counts a run", async () => {
  expect(crewNote(child)).toBe("The crew is building on $2 of $2 included credit.");
  await refreshFunding(child, async () => new Response(JSON.stringify({ capUsd: 2, spentUsd: 0.5 })));
  expect(fundingOf(dir)?.spentUsd).toBe(0.5);
  expect(crewNote(child)).toBe("The crew is building on $1.50 of $2 included credit.");
});
