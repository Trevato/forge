import { expect, test } from "bun:test";
import { PAGE_BUDGETS, pagePath } from "../src/perf/page_budget.ts";

test("pagePath fills :owner and :name and leaves fixed paths alone", () => {
  const app = PAGE_BUDGETS.find((b) => b.pattern === "/:owner/:name")!;
  expect(pagePath(app, "alice", "notes")).toBe("/alice/notes");
  expect(pagePath(app, "a b", "x/y")).toBe("/a%20b/x%2Fy");
  expect(pagePath(PAGE_BUDGETS[0]!, "alice", "notes")).toBe("/");
});
