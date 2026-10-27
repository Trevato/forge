import { expect, test } from "bun:test";
import { clogStep } from "../src/flow/clog_watch.ts";

test("quiet with no clog stays null", () => {
  expect(clogStep(null, [], 1)).toEqual({ state: null, event: null });
});

test("a reason starts a clog once and it stands without repeats", () => {
  const a = clogStep(null, ["red main"], 10);
  expect(a.event).toBe("started");
  expect(a.state).toEqual({ since: 10, firstReasons: ["red main"] });
  const b = clogStep(a.state, ["red main", "stuck"], 20);
  expect(b.event).toBeNull();
  expect(b.state).toEqual({ since: 10, firstReasons: ["red main"] });
});

test("one quiet reading is still standing; a reason resets the count", () => {
  const a = clogStep(null, ["x"], 10);
  const b = clogStep(a.state, [], 20);
  expect(b.event).toBeNull();
  expect(b.state?.since).toBe(10);
  const c = clogStep(b.state, ["x"], 30);
  const d = clogStep(c.state, [], 40);
  expect(d.event).toBeNull();
  expect(d.state).not.toBeNull();
});

test("two quiet readings in a row clear it with the start time", () => {
  let s = clogStep(null, ["x"], 10).state;
  s = clogStep(s, [], 20).state;
  const c = clogStep(s, [], 30);
  expect(c).toEqual({ state: null, event: "cleared", since: 10 });
});

test("a clog after a clear starts anew", () => {
  const c = clogStep(clogStep(clogStep(null, ["x"], 10).state, [], 20).state, [], 30);
  const r = clogStep(c.state, ["y"], 50);
  expect(r.event).toBe("started");
  expect(r.state).toEqual({ since: 50, firstReasons: ["y"] });
});
