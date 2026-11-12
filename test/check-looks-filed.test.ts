/** A commit's looks are filed as each is taken, so an interrupted round loses none (#10336). */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCommitLook, commitLooksPath, readLooks } from "../src/checks/looks.ts";
import { vitalsRows } from "../src/checks/summary.ts";
import { PREVIEW_MOVE_LOOK, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";

const dir = await mkdtemp(join(tmpdir(), "forge-looks-filed-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const OID = "a".repeat(40);
const run = { id: "r1", repoId: "repo1", commitOid: OID };
const size = { scrollWidth: 390, scrollHeight: 900, innerWidth: 390, innerHeight: 844 };

test("looks filed in separate rounds are all there, and a retaken one replaces its earlier self", () => {
  addCommitLook(dir, "repo1", OID, { look: "phone /a", entries: {} });
  // A later round (the first was cut short) files only what it takes.
  addCommitLook(dir, "repo1", OID, { look: `phone ${PREVIEW_MOVE_LOOK}`, entries: {}, size });
  addCommitLook(dir, "repo1", OID, { look: "phone /a", skipped: "no browser" });
  const read = readLooks(dir, run);
  expect(read.map((l) => l.look).sort()).toEqual(["phone /a", `phone ${PREVIEW_MOVE_LOOK}`]);
  const move = vitalsRows(read).find((g) => g.look === `phone ${PREVIEW_MOVE_LOOK}`);
  expect(move?.size).toEqual(size);
  expect(commitLooksPath(dir, "repo1", OID)).toContain(OID);
});

test("every look of the forge's own preview fits in the set", () => {
  const all = PREVIEW_OWNER_LOOKS.filter((l) => l.kind !== "thumb");
  for (const l of all)
    addCommitLook(dir, "repo2", OID, { look: `${l.kind} ${l.page}`, entries: {}, size });
  const read = readLooks(dir, { id: "r2", repoId: "repo2", commitOid: OID });
  expect(read).toHaveLength(all.length);
  expect(read.some((l) => l.look === `phone ${PREVIEW_MOVE_LOOK}`)).toBe(true);
});
