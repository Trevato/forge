/**
 * The home's included-credit line says what the host counted (#11614): one
 * $0.48 answer against $2 leaves $1.52 and the crew is building; only spend
 * reaching the cap reads "spent".
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addSpend, readCredit, setCap, usdWords } from "../src/spawn/credit.ts";
import { keepFunding } from "../src/spawn/funding.ts";
import { listPriceUsd } from "../src/spawn/list_price.ts";
import { crewNote, includedCredit } from "../src/web/studio/crew_key.ts";

let dir = "";
let parent: App;
let child: App;
let childDir = "";

/** What the host last told the child, as the heartbeat keeps it. */
const heard = (): void => {
  const c = readCredit(parent, "maria")!;
  keepFunding(childDir, { token: "maria.bearer-token", capUsd: c.capUsd, spentUsd: c.spentUsd });
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "credit-figure-"));
  childDir = join(dir, "child");
  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, "parent.json"), "{}");
  parent = createApp({ dataDir: join(dir, "parent"), url: "https://forge.test", port: 0 });
  child = createApp({ dataDir: childDir, port: 0 });
  setCap(parent, "maria", 2, false, (token, credit) => keepFunding(childDir, { token, capUsd: credit.capUsd, spentUsd: credit.spentUsd }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("one $0.48 answer leaves $1.52 and the home says it is building", () => {
  // 32,000 output tokens of a sonnet answer at list price is $0.48.
  const cost = listPriceUsd("claude-sonnet-4-5", { inputTokens: 0, outputTokens: 32_000, cacheWriteTokens: 0, cacheReadTokens: 0 });
  expect(cost).toBeCloseTo(0.48, 6);
  addSpend(parent, "maria", cost);
  heard();
  const c = includedCredit(child)!;
  expect(c).toEqual({ capUsd: 2, spentUsd: 0.48, leftUsd: 1.52 });
  expect(crewNote(child)).toBe(`The crew is building on ${usdWords(1.52)} of ${usdWords(2)} included credit.`);
});

test("a credit with nothing counted yet is whole, never spent", () => {
  keepFunding(childDir, { token: "maria.bearer-token", capUsd: 2, spentUsd: null });
  expect(includedCredit(child)).toEqual({ capUsd: 2, spentUsd: 0, leftUsd: 2 });
});

test("spend reaching the cap reads the spent line", () => {
  addSpend(parent, "maria", 1.52);
  heard();
  expect(includedCredit(child)!.spentUsd).toBe(2);
  expect(includedCredit(child)!.leftUsd).toBe(0);
  expect(crewNote(child)).toBe("The included credit is spent; the crew needs a model key to go on.");
});
