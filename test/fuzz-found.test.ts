/** Cases the fuzzer found, kept as fixed tests (test/fuzz-parsers.test.ts). */
import { expect, test } from "bun:test";
import { body } from "../src/http/respond.ts";

test("a JSON array body is not an object body (fuzz seed 1244, case \"[]\")", async () => {
  for (const text of ["[]", "[1,2]", '[{"title":"x"}]'])
    expect(await body(new Request("http://x.test/", { method: "POST", body: text }))).toEqual({});
});
