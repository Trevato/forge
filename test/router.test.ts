import { expect, test } from "bun:test";
import { Router } from "../src/http/router.ts";

test("match names the pattern it matched", () => {
  const router = new Router<string>()
    .add("GET", "/a/:id", "one")
    .add("GET", "/files/*rest", "files")
    .add("GET", "/", "root");
  for (const id of ["1", "2", "3"]) {
    const m = router.match("GET", `/a/${id}`);
    expect(m?.pattern).toBe("/a/:id");
    expect(m?.params).toEqual({ id });
    expect(m?.handler).toBe("one");
  }
  const rest = router.match("GET", "/files/x/y");
  expect(rest?.pattern).toBe("/files/*rest");
  expect(rest?.params).toEqual({ rest: "x/y" });
  expect(router.match("GET", "/")?.pattern).toBe("/");
  expect(router.match("GET", "/nope")).toBeUndefined();
});
