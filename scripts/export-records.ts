/**
 * Writes test/fixtures/forge-records.txt: every issue and pull number on the
 * forge, as ranges ("1-40 42 45-50"), so tests can check a `#N` offline.
 * Run: FORGE_URL=… FORGE_TOKEN=… bun scripts/export-records.ts
 */
import { join } from "node:path";
import { compactRecords } from "../src/story/records.ts";

const { FORGE_URL, FORGE_TOKEN } = process.env;
if (!FORGE_URL || !FORGE_TOKEN) {
  console.error("export-records: set FORGE_URL and FORGE_TOKEN");
  process.exit(1);
}
const base = `${FORGE_URL}/api/v1/repos/trevato/forge`;
const nums = new Set<number>();
for (const kind of ["issues", "pulls"]) {
  let cursor: number | null = null;
  do {
    const q = `state=all&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await fetch(`${base}/${kind}?${q}`, { headers: { authorization: `Bearer ${FORGE_TOKEN}` } });
    if (!res.ok) throw new Error(`${kind}: ${res.status}`);
    const body = (await res.json()) as { items: { number: number }[]; next_cursor?: number | null };
    for (const i of body.items) nums.add(i.number);
    cursor = body.next_cursor ?? null;
  } while (cursor);
}
await Bun.write(join(import.meta.dir, "../test/fixtures/forge-records.txt"), compactRecords(nums) + "\n");
console.log(`${nums.size} numbers`);
