import { test } from "bun:test";
import { btn, empty } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";


test("empty: a line, a note, an action", () => {
  expectAccessible(empty({ icon: "check", title: "Nothing here", note: "Yet" }));
  expectAccessible(empty({ title: "No apps", action: btn("Make one", { href: "/new", variant: "primary" }) }));
});
