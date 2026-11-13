import { test } from "bun:test";
import { field } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";

// `select.input` pads its right side for the arrow: physical, and named here until it flips.
const SELECT = { physical: ["select.input"] };

test("field: text, textarea, select, checkbox, error, hidden label", () => {
  expectAccessible(field({ label: "Name", name: "name", hint: "Shown to others", required: true }));
  expectAccessible(field({ label: "Notes", name: "notes", type: "textarea", error: "Too long" }));
  expectAccessible(field({ label: "Kind", name: "kind", type: "select", options: [{ value: "a", label: "A" }] }), SELECT);
  expectAccessible(field({ label: "Public", name: "pub", type: "checkbox", checked: true }));
  expectAccessible(field({ label: "Search", name: "q", labelHidden: true }));
});
