import { test } from "bun:test";
import { iconBtn } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";

test("iconBtn: its label is its name", () => {
  expectAccessible(iconBtn("copy", "Copy address", { type: "button" }));
  expectAccessible(iconBtn("copy", "Copy address", { href: "/x" }));
});
