import { test } from "bun:test";
import { crumbs } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";

// The stylesheet gives a breadcrumb link no height: named here, not passed silently.
const UNSIZED = { unsized: ["a"] };

test("crumbs: links, a current page, a mono path", () => {
  expectAccessible(crumbs([{ label: "Apps", href: "/apps" }, { label: "notes", href: "/notes" }, { label: "Settings" }]), UNSIZED);
  expectAccessible(crumbs([{ label: "src", href: "/s" }, { label: "a.ts" }], { mono: true, ariaLabel: "Path" }), UNSIZED);
});
