/**
 * The pill can be moved (#3448): dragged to a corner, or walked there with
 * the arrow keys; the corner is kept per app host and the panel opens
 * toward the inside of the screen.
 */

import { describe, expect, test } from "bun:test";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { boot } from "./helpers/toolbar-boot.ts";

describe("moving the pill", () => {
  test("starts bottom-right and the panel opens to its left", () => {
    const { host, box } = boot({});
    expect(host.style.right).toBe("12px");
    expect(host.style.bottom).toBe("12px");
    expect(host.style.top).toBe("auto");
    expect(box.style.flexDirection).toBe("row-reverse");
  });

  test("a drag snaps to the nearest corner and is remembered", () => {
    const store: Record<string, string> = {};
    const { host, box, pill, fire } = boot(store);
    fire(pill, "pointerdown", { clientX: 380, clientY: 780 });
    fire(pill, "pointermove", { clientX: 100, clientY: 60 });
    expect(host.style.left).toBe("78px"); // follows the pointer while dragging
    fire(pill, "pointerup", { clientX: 100, clientY: 60 });
    expect(host.style.top).toBe("48px");
    expect(host.style.left).toBe("12px");
    expect(host.style.right).toBe("auto");
    expect(box.style.flexDirection).toBe("row");
    expect(box.style.alignItems).toBe("flex-start");
    expect(store["forge-pill-corner"]).toBe("tl");
    // The next page load puts it there again.
    expect(boot(store).host.style.left).toBe("12px");
    expect(boot(store).host.style.top).toBe("48px");
  });

  test("a press that barely moves is a tap, not a drag", () => {
    const store: Record<string, string> = {};
    const { pill, fire, panel } = boot(store);
    fire(pill, "pointerdown", { clientX: 380, clientY: 780 });
    fire(pill, "pointermove", { clientX: 382, clientY: 781 });
    fire(pill, "pointerup", { clientX: 382, clientY: 781 });
    fire(pill, "click");
    expect(store["forge-pill-corner"]).toBeUndefined();
    expect(panel.hidden).toBe(false);
  });

  test("the click that ends a drag does not open the panel", () => {
    const { pill, fire, panel } = boot({});
    fire(pill, "pointerdown", { clientX: 380, clientY: 780 });
    fire(pill, "pointermove", { clientX: 20, clientY: 780 });
    fire(pill, "pointerup", { clientX: 20, clientY: 780 });
    fire(pill, "click");
    expect(panel.hidden).toBe(true);
  });

  test("arrow keys walk it from corner to corner", () => {
    const store: Record<string, string> = {};
    const { host, pill, fire } = boot(store);
    fire(pill, "keydown", { key: "ArrowLeft" });
    expect(store["forge-pill-corner"]).toBe("bl");
    expect(host.style.left).toBe("12px");
    fire(pill, "keydown", { key: "ArrowUp" });
    expect(store["forge-pill-corner"]).toBe("tl");
    fire(pill, "keydown", { key: "ArrowRight" });
    fire(pill, "keydown", { key: "ArrowDown" });
    expect(store["forge-pill-corner"]).toBe("br");
    fire(pill, "keydown", { key: "a" });
    expect(store["forge-pill-corner"]).toBe("br");
  });

  test("an arrow move is announced in plain words", () => {
    const { box, pill, fire } = boot({});
    const sr = box.children.find((c: any) => c.attrs.role === "status")!;
    fire(pill, "keydown", { key: "ArrowLeft" });
    expect(sr.textContent).toBe("Moved to the bottom left");
    fire(pill, "keydown", { key: "ArrowUp" });
    expect(sr.textContent).toBe("Moved to the top left");
  });

  test("an arrow that changes nothing says nothing", () => {
    const { box, pill, fire } = boot({ "forge-pill-corner": "tl" });
    const sr = box.children.find((c: any) => c.attrs.role === "status")!;
    fire(pill, "keydown", { key: "ArrowLeft" });
    expect(sr.textContent ?? "").toBe("");
  });

  test("a garbage stored corner is ignored; no storage at all still works", () => {
    expect(boot({ "forge-pill-corner": "<x>" }).host.style.right).toBe("12px");
    const { host, pill, fire } = boot(null);
    fire(pill, "keydown", { key: "ArrowLeft" });
    expect(host.style.left).toBe("12px");
  });

  test("a cancelled drag leaves the pill answering a later keyboard click", () => {
    const { pill, fire, panel } = boot({});
    fire(pill, "pointerdown", { clientX: 380, clientY: 780 });
    fire(pill, "pointermove", { clientX: 20, clientY: 780 });
    fire(pill, "pointercancel", { clientX: 20, clientY: 780 });
    fire(pill, "click");
    expect(panel.hidden).toBe(false);
  });

  test("after a released drag, the next click a moment later opens the panel", async () => {
    const { pill, fire, panel } = boot({});
    fire(pill, "pointerdown", { clientX: 380, clientY: 780 });
    fire(pill, "pointermove", { clientX: 20, clientY: 780 });
    fire(pill, "pointerup", { clientX: 20, clientY: 780 });
    await Bun.sleep(80);
    fire(pill, "click");
    expect(panel.hidden).toBe(false);
  });

  test("the pill has no hide item and no hint: it only moves", () => {
    expect(toolbarJs).not.toMatch(/Hide for this page|Move: drag/);
  });

  test("the panel is bounded to the screen", () => {
    expect(toolbarJs).toContain("max-width:min(320px,calc(100vw - 64px))");
    expect(toolbarJs).toContain("max-height:min(70vh,calc(100vh - 88px))");
  });
});
