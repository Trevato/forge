/**
 * The display model: a display.json reads into a config, a malformed one is
 * refused with a named error, items order by their list, selections name the
 * displays holding a build, and an empty display compiles to an empty shelf.
 */
import { describe, expect, test } from "bun:test";
import { shelfOf } from "../src/arcade/shelf.ts";
import { parseDisplay } from "../src/display/config.ts";
import { orderItems } from "../src/display/items.ts";
import { selectionsHolding, type DisplaySelection } from "../src/display/selections.ts";

const good = {
  title: "Arcade",
  layout: "shelf",
  sources: ["jmoran", "common-arcade/kart-live"],
  order: ["common-arcade/kart-live:fiesta-1.0"],
  demos: { "jmoran/nova-moves:iter-5-brawl": { launch: "file" } },
  shelf: { producer: "jbox" },
  builds: ["jmoran/nova:b", "jmoran/nova:a"],
};

const refused = (value: unknown): string => {
  const parsed = parseDisplay(typeof value === "string" ? value : JSON.stringify(value));
  expect(parsed.ok).toBe(false);
  return parsed.ok ? "" : parsed.error;
};

describe("display.json", () => {
  test("a good file reads into a config", () => {
    const parsed = parseDisplay(JSON.stringify(good));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.title).toBe("Arcade");
    expect(parsed.value.layout).toBe("shelf");
    expect(parsed.value.sources).toEqual([
      { kind: "owner", owner: "jmoran" },
      { kind: "repo", owner: "common-arcade", name: "kart-live" },
    ]);
    expect(parsed.value.demos.get("jmoran/nova-moves:iter-5-brawl")).toEqual({ launch: "file" });
    expect(parsed.value.builds).toEqual(["jmoran/nova:b", "jmoran/nova:a"]);
  });

  test("a malformed one is refused with a named error", () => {
    expect(refused("{ nope")).toStartWith("display.json: not valid JSON");
    expect(refused([])).toBe("display.json: must be a JSON object");
    expect(refused({ ...good, layout: "carousel" })).toBe("display.json: layout must be shelf, grid or graph");
    expect(refused({ ...good, title: "" })).toContain("title is required");
    expect(refused({ ...good, sources: ["--upload-pack"] })).toContain("is not an owner or owner/name");
    expect(refused({ ...good, builds: ["a/b:c", "a/b:c"] })).toBe("display.json: builds names a/b:c twice");
    expect(refused({ ...good, producer: "jbox" })).toBe('display.json: unknown key "producer"');
  });
});

describe("items and selections", () => {
  test("named demos come first, then the rest oldest pinned first", () => {
    const item = (key: string, at: string) => ({ key, pin: { pinnedAt: at } });
    const items = [item("a/x:new", "2026-10-03"), item("a/x:old", "2026-10-01"), item("a/x:mid", "2026-10-02"), item("a/x:hand", "2026-10-04")];
    expect(orderItems(items, ["a/x:hand", "a/x:gone", "a/x:mid"]).map((i) => i.key)).toEqual(["a/x:hand", "a/x:mid", "a/x:old", "a/x:new"]);
  });

  test("a build is in Showcased and each display that lists it", () => {
    const display = (title: string, keys: string[]) => ({ id: title, title, keys }) as unknown as DisplaySelection;
    const displays = [display("Shelf", ["a/x:one"]), display("Other", ["a/x:two"])];
    expect(selectionsHolding("a/x:one", true, displays)).toEqual(["Showcased", "Shelf"]);
    expect(selectionsHolding("a/x:two", false, displays)).toEqual(["Other"]);
  });

  test("an empty display compiles to an empty shelf", () => {
    const shelf = shelfOf([], "jbox");
    expect(shelf.games).toEqual([]);
    expect(shelf.entries.size).toBe(0);
  });
});
