// The release proof looks at a phone (#11855): a closed dialog drawn over the page fails the verify.
import { describe, expect, test } from "bun:test";
import { centreVerdict, parseCentre, phoneGate, verifyPhone, type Layer } from "../src/keeper/covered.ts";

const layer = (o: Partial<Layer>): Layer => ({ tag: "p", position: "static", popover: false, hidden: false, width: 100, height: 40, ...o });
const page = [layer({ tag: "main" }), layer({ tag: "body" })];

describe("centreVerdict", () => {
  test("the page's own content at the centre is not covered", () => {
    expect(centreVerdict({ layers: page })).toBeUndefined();
  });
  test("a full-screen dialog (the 0.7.549 palette) covers", () => {
    const palette = layer({ tag: "dialog", position: "fixed", width: 390, height: 844 });
    expect(centreVerdict({ layers: [palette, ...page] })).toContain("<dialog>");
  });
  test("a popover and a hidden element cover", () => {
    expect(centreVerdict({ layers: [layer({ tag: "div", popover: true })] })).toContain("popover");
    expect(centreVerdict({ layers: [layer({ tag: "div", hidden: true })] })).toContain("hidden");
  });
  test("a fixed layer over a quarter of the screen covers; a fixed bar does not", () => {
    expect(centreVerdict({ layers: [layer({ position: "fixed", width: 390, height: 300 }), ...page] })).toContain("fixed");
    expect(centreVerdict({ layers: [layer({ position: "fixed", width: 390, height: 56 }), ...page] })).toBeUndefined();
  });
  test("a fixed ancestor counts, not only the topmost element", () => {
    expect(centreVerdict({ layers: [layer({ tag: "span" }), layer({ tag: "div", position: "fixed", width: 390, height: 844 })] })).toContain("fixed");
  });
  test("nothing at the centre is a cover", () => {
    expect(centreVerdict({ layers: [] })).toContain("nothing");
  });
});

describe("parseCentre", () => {
  test("narrows what the page said; junk is no layers", () => {
    expect(parseCentre("not json").layers).toEqual([]);
    expect(parseCentre(JSON.stringify({ layers: [{ tag: "dialog", position: "fixed", width: "x", height: 5 }, 7] })).layers).toEqual([
      { tag: "dialog", position: "fixed", popover: false, hidden: false, width: 0, height: 5 },
    ]);
  });
});

describe("verifyPhone", () => {
  test("fails on the first covered page, naming it and the size", async () => {
    const seen: string[] = [];
    const v = await verifyPhone(["/", "/a/b", "/apps"], async (p) => {
      seen.push(p);
      return { layers: p === "/a/b" ? [layer({ tag: "dialog", position: "fixed", width: 390, height: 844 })] : page };
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("/a/b at 390×844");
    expect(seen).toEqual(["/", "/a/b"]);
  });
  test("passes clean pages; a look that could not be made is not a cover", async () => {
    const v = await verifyPhone(["/", "/apps"], async (p) => (p === "/" ? undefined : { layers: page }));
    expect(v).toEqual({ ok: true, reason: "", looked: 1 });
  });
});

const covered = { layers: [layer({ tag: "dialog", position: "fixed", width: 390, height: 844 })] };
const loaded = { ok: true as const, tally: { n: 1 } };

describe("verifyPhone", () => {
  test("a blank centre is looked at again after a longer settle; one that fills is fine", async () => {
    const settles: number[] = [];
    const v = await verifyPhone(["/"], async (_p, ms) => (settles.push(ms), ms > 500 ? { layers: page } : { layers: [] }));
    expect(v.ok).toBe(true);
    expect(settles).toEqual([500, 3000]);
  });
  test("a centre still blank after the retry fails", async () => {
    expect((await verifyPhone(["/"], async () => ({ layers: [] }))).ok).toBe(false);
  });
  test("a look that throws or hangs is not a cover", async () => {
    expect((await verifyPhone(["/"], async () => { throw new Error("x"); })).looked).toBe(0);
    expect((await verifyPhone(["/"], () => new Promise(() => {}), { lookMs: 10 })).ok).toBe(true);
  });
  test("past the deadline no more pages are looked at", async () => {
    let t = 0;
    const seen: string[] = [];
    await verifyPhone(["/a", "/b"], async (p) => (seen.push(p), (t += 100), { layers: page }), { now: () => t, deadlineMs: 50 });
    expect(seen).toEqual(["/a"]);
  });
});

describe("phoneGate", () => {
  test("a covered phone page turns the verify into a failure naming it", async () => {
    const r = await phoneGate(loaded, ["/apps"], async () => covered);
    expect(r).toMatchObject({ ok: false, tally: loaded.tally });
    expect((r as { reason: string }).reason).toStartWith("covered at phone size: /apps at 390×844");
  });
  test("a clean page returns the load result unchanged", async () => {
    expect(await phoneGate(loaded, ["/"], async () => ({ layers: page }))).toBe(loaded);
  });
  test("no Chromium skips the look", async () => {
    expect(await phoneGate(loaded, ["/"], undefined)).toBe(loaded);
  });
});

test("the keeper's verify goes through phoneGate, with the session token kept whole as the cookie value", async () => {
  const src = await Bun.file(new URL("../src/keeper/wire.ts", import.meta.url)).text();
  expect(src).toContain("return phoneGate(loaded, phonePages(repo), look)");
  expect(src).toContain('{ name: "forge_session", value: session.token }');
});
