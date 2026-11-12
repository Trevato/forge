import { expect, test } from "bun:test";
import { governorLine, type GovernorSeen } from "../src/crew/governed.ts";
import { governorRows } from "../src/web/studio/governor_rows.ts";

const seen = (over: Partial<GovernorSeen>): GovernorSeen => ({ slots: 3, ceiling: 7, held: true, says: "", why: "Builders 3: busy", ...over });

test("the card's Governor row shows the last change once, and the reason alone when there is none (#11459)", () => {
  const said = String(governorRows(seen({ says: "Builders 7 → 3 at 20:41: 9 opened vs 2 landed" })));
  expect(said).toContain("<dt>Governor</dt>");
  expect(said).toContain("Builders 7 → 3 at 20:41: 9 opened vs 2 landed");
  expect(said).not.toContain("Builders 3: busy");
  expect(said).not.toContain("Last");
  expect(String(governorRows(seen({})))).toContain("Builders 3: busy");
  expect(governorRows(undefined)).toBeNull();
});

test("after a release the line says back-to and the current reason", () => {
  expect(governorLine(seen({ held: false, says: "Builders back to 7 at 21:30", why: "Builders 7: quiet" }))).toBe("Builders back to 7 at 21:30. Builders 7: quiet");
});
