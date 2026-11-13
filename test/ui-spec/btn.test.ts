import { test } from "bun:test";
import { btn } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";

test("btn: link, submit, labelled, toggle", () => {
  expectAccessible(btn("Save"));
  expectAccessible(btn("Docs", { href: "/docs", external: true, variant: "outline" }));
  expectAccessible(btn("Big", { size: "lg", variant: "primary" }));
  expectAccessible(btn("Pin", { pressed: true, type: "button" }));
});
