/**
 * The space's client arithmetic (#10444), the same functions the page ships
 * (`space_view.ts`): placement over time, the crew at a time, the address
 * hash both ways, and which issue a tap lands on.
 */
import { expect, test } from "bun:test";
import { crewAt, hashOf, parseHash, pickIssue, placeAt } from "../src/web/space_view.ts";
import { spaceJs } from "../src/web/space_client.ts";

// [number, cluster, x, y, created, closed, title, pull, bx, by, bcluster, hold, check]
const open = [1, 0, 100, 100, 1000, 0, "open", 0, 0, 0, 0, "", ""];
const closed = [2, 1, 300, 100, 1000, 5000, "closed", 0, 100, 100, 2, "", ""];
const GLIDE = 4 * 3600000;

test("placeAt: not there before it is opened; open issues sit in place", () => {
  expect(placeAt(open, 999)).toBeNull();
  expect(placeAt(open, 1000)).toEqual([100, 100, 0, 0]);
});

test("placeAt: an issue waits in review until it closes, then glides to landed", () => {
  expect(placeAt(closed, 4999)).toEqual([100, 100, 2, 0]);
  expect(placeAt(closed, 5000)).toEqual([100, 100, 2, 0]);
  const mid = placeAt(closed, 5000 + GLIDE / 2)!;
  expect(mid[0]).toBeCloseTo(200, 6); // ease(.5) = .5, halfway from 100 to 300
  expect(mid[3]).toBeCloseTo(0.5, 6);
  expect(placeAt(closed, 5000 + GLIDE / 4)![2]).toBe(2); // before half-way: still counted in review
  expect(placeAt(closed, 5000 + GLIDE)).toEqual([300, 100, 1, 1]);
});

test("crewAt: a member is on the latest run that had started and not ended", () => {
  const crew = [
    { name: "torque", runs: [[1, 1000, 3000], [2, 6000, 0]] },
    { name: "mason", runs: [[1, 1500, 0]] },
  ];
  const rows = [open, closed];
  expect(crewAt(crew, rows, 500)).toEqual([]);
  const at2000 = crewAt(crew, rows, 2000);
  expect(at2000.map((m) => [m.name, m.issue, m.slot])).toEqual([["torque", 1, 0], ["mason", 1, 1]]); // two on one issue take slots
  expect(crewAt(crew, rows, 4000).map((m) => m.name)).toEqual(["mason"]); // torque's run ended
  const late = crewAt(crew, rows, 7000);
  expect(late.map((m) => [m.name, m.issue])).toEqual([["torque", 2], ["mason", 1]]);
  expect(late[0]!.x).toBeCloseTo(100, 3); // issue 2 has only begun to glide from review
});

const S = { world: { w: 1000, h: 500 }, weekStart: 60_000_000, now: 66_000_000 };

test("parseHash: reads the view, clamps it into the plane, drops what is not a number", () => {
  const v = parseHash("#x=250&y=125&z=2", S, 0.5, [0.25, 30]);
  expect(v).toEqual({ x: 250, y: 125, k: 1 });
  expect(parseHash("#x=-50&y=9999&z=1000", S, 0.5, [0.25, 30])).toEqual({ x: 0, y: 500, k: 30 });
  expect(parseHash("#x=abc&y=1&z=1", S, 1, [0.5, 9])).toEqual({});
  expect(parseHash("#x=1&y=1&z=0", S, 1, [0.5, 9])).toEqual({});
  expect(parseHash("", S, 1, [0.5, 9])).toEqual({});
});

test("parseHash: a time is minutes since the epoch, kept only inside the week", () => {
  expect(parseHash("#t=1050", S, 1, [1, 2]).t).toBe(63_000_000);
  expect(parseHash("#t=1", S, 1, [1, 2])).toEqual({});
  expect(parseHash(`#t=${S.now / 60000}`, S, 1, [1, 2])).toEqual({}); // now is live, not a time
});

test("hashOf and parseHash are inverses", () => {
  const view = { x: 412, y: 77, k: 3 };
  const h = hashOf(view, 1.5, false, 63_000_000);
  expect(h).toBe("x=412&y=77&z=2.000&t=1050");
  expect(parseHash(h, S, 1.5, [0.1, 100])).toEqual({ x: 412, y: 77, k: 3, t: 63_000_000 });
  expect(hashOf(view, 1.5, true, 0)).not.toContain("t=");
});

test("pickIssue: the cell under the tap, the nearest centre, none where the plane is empty", () => {
  const clusters = [[0, 0, 0, 0, 0, 0, 40, 0], [0, 1, 0, 0, 0, 0, 40, 0], [0, 2, 0, 0, 0, 0, 40, 0]];
  const a = [1, 0, 100, 100, 0, 0, "a", 0, 0, 0, 0, "", ""];
  const b = [2, 0, 130, 100, 0, 0, "b", 0, 0, 0, 0, "", ""];
  const later = [3, 0, 100, 100, 9000, 0, "later", 0, 0, 0, 0, "", ""];
  expect(pickIssue([a, b], clusters, 1, 120, 100)![0]).toBe(2); // both cells hold x=120; b's centre is nearer
  expect(pickIssue([a, b], clusters, 1, 105, 100)![0]).toBe(1);
  expect(pickIssue([a, b], clusters, 1, 500, 500)).toBeNull();
  expect(pickIssue([later], clusters, 1, 100, 100)).toBeNull(); // not opened yet at T=1
});

test("the page ships these functions, not a second copy", () => {
  for (const name of ["placeAt", "crewAt", "parseHash", "hashOf", "pickIssue"]) expect(spaceJs).toContain(`function ${name}(`);
  new Bun.Transpiler({ loader: "js" }).transformSync(spaceJs);
});
