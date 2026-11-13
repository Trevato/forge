import { test } from "bun:test";
import { selectField } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";

// `select.input` pads its right side for the arrow: physical, and named here until it flips.
const SELECT = { physical: ["select.input"] };

test("selectField: label, hint and error", () => {
  expectAccessible(
    selectField({ label: "Kind", name: "kind", hint: "Pick one", error: "Required", options: [{ value: "a", label: "A" }] }),
    SELECT,
  );
});
