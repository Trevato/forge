import { test } from "bun:test";
import { disclosure } from "../../src/web/ui.ts";
import { expectAccessible } from "./helper.ts";

test("disclosure: a summary names the fold", () => {
  expectAccessible(disclosure("Details", "Body text"));
  expectAccessible(disclosure("More", "Body", { small: true, label: "More about this" }));
});
