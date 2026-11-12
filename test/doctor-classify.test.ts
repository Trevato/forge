import { describe, expect, test } from "bun:test";
import { classify, reproduce } from "../src/checks/doctor_classify.ts";
import { redFor } from "./helpers/doctor.ts";

const of = (error: string, reason?: Parameters<typeof redFor>[3]) => {
  const red = redFor("t", "test/a.test.ts", error, reason);
  return classify(red.reason, red.tests);
};

describe("the batch doctor classes a red", () => {
  test("every test over its budget is a budget red", () => {
    const d = of("error: over budget (expectBudget): GET / took 90ms, budget 50ms");
    expect(d.class).toBe("budget");
    expect(d.probe).toContain("over budget");
  });

  test("ENOENT, tarball and disk errors are infra", () => {
    expect(of("error: ENOENT: no such file or directory, open 'x'").class).toBe("infra");
    expect(of("error: tar: extract failed: unexpected end of tarball").class).toBe("infra");
    expect(of("error: ENOSPC: no space left on device").class).toBe("infra");
  });

  test("a functional error that merely says extract or tarball is not infra", () => {
    expect(of("error: expected extract() to return 3").class).toBe("functional");
    expect(of("error: tarball is not a function").class).toBe("functional");
  });

  test("a gate that stopped before its tests is infra", () => {
    expect(of("", { kind: "install" }).class).toBe("infra");
    expect(of("", { kind: "timeout" }).class).toBe("infra");
  });

  test("anything else is functional, with the test and its error line as the probe", () => {
    const d = of("error: expect(received).toBe(expected)");
    expect(d.class).toBe("functional");
    expect(d.test?.name).toBe("t");
    expect(d.probe).toBe("error: expect(received).toBe(expected)");
  });

  test("a mix of budget and functional reds is functional", () => {
    const red = redFor("a", "test/a.test.ts", "error: over budget (expectBudget): slow");
    const tests = { ...red.tests!, failed: 2, failing: [...red.tests!.failing, { name: "b", file: "test/b.test.ts", errors: ["error: boom"] }] };
    expect(classify(red.reason, tests).class).toBe("functional");
  });

  test("the reproduce command refuses a file that is not a plain path", () => {
    expect(reproduce({ name: "t", file: "test/a.test.ts", errors: [] })).toBe("bun test ./test/a.test.ts");
    expect(reproduce({ name: "t", file: "a; rm -rf /", errors: [] })).toBeUndefined();
    expect(reproduce(undefined)).toBeUndefined();
  });
});
