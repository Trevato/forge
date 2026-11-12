/**
 * On a phone a top-corner pill sits clear of the camera (#7714), and opening
 * the panel moves nothing.
 */

import { describe, expect, test } from "bun:test";
import { boot } from "./helpers/toolbar-boot.ts";

const at = (corner: string, width: number) => boot({ "forge-pill-corner": corner }, width, 844);

describe("the pill and the camera", () => {
  for (const c of ["tl", "tr"]) {
    test(`${c} sits 48px down at 390 wide and 360 wide, 12px at 1440`, () => {
      expect(at(c, 390).host.style.top).toBe("48px");
      expect(at(c, 360).host.style.top).toBe("48px");
      expect(at(c, 600).host.style.top).toBe("48px");
      expect(at(c, 601).host.style.top).toBe("12px");
      expect(at(c, 1440).host.style.top).toBe("12px");
    });
  }

  for (const c of ["bl", "br"]) {
    test(`${c} keeps bottom:12px at any width`, () => {
      for (const w of [360, 390, 1440]) {
        const { host, panel } = at(c, w);
        expect(host.style.bottom).toBe("12px");
        expect(host.style.top).toBe("auto");
        expect(panel.style.maxHeight ?? "").toBe("");
      }
    });
  }

  test("a narrow top-corner panel is capped for the lower pill; others keep the pinned cap", () => {
    expect(at("tr", 390).panel.style.maxHeight).toBe("min(70vh,calc(100vh - 124px))");
    expect(at("tr", 1440).panel.style.maxHeight).toBe("");
  });

  test("opening and closing the panel leaves the host where it was", () => {
    for (const [c, w] of [["tr", 390], ["tl", 390], ["tr", 1440], ["br", 390]] as const) {
      const { host, pill, panel, fire } = at(c, w);
      const before = { ...host.style };
      fire(pill, "click");
      expect(panel.style.display).toBe("flex");
      expect(host.style).toEqual(before);
      fire(pill, "click");
      expect(panel.style.display).toBe("none");
      expect(host.style).toEqual(before);
    }
  });
});
