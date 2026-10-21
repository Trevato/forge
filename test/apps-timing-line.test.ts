import { expect, test } from "bun:test";
import { Stopwatch } from "../src/apps/timing.ts";

const watch = () => {
  let t = 0;
  const w = new Stopwatch(() => t);
  return { w, at: (ms: number) => (t = ms) };
};

test("the deploy line keeps its wording", () => {
  const { w, at } = watch();
  at(300);
  w.lap("turn");
  at(1000);
  expect(w.line("serving")).toBe("timing: serving 1.0s after the deploy started — turn 0.3s");
});

test("a run line says it counts from the run started", () => {
  const { w, at } = watch();
  at(1000);
  w.lap("clone");
  at(1500);
  w.lap("brief");
  at(12000);
  expect(w.line("run ended", "the run started")).toBe(
    "timing: run ended 12.0s after the run started — clone 1.0s · brief 0.5s",
  );
});
