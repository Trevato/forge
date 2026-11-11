import { expect, test } from "bun:test";
import { resultLine } from "./helpers/result-line.ts";

test("a helper's result is found under the child's shutdown lines that follow it (#10541)", () => {
  const out = [
    '2026-11-10T03:34:05.000Z INFO  [forge] child forge name=kid line="booted"',
    '{"placement":"cell","status":200,"body":"bakery says hi","app":"bakery"}',
    '2026-11-10T03:34:05.253Z INFO  [forge] child forge name=kid line="forge draining: /readyz answers 503 from now"',
    '2026-11-10T03:34:15.239Z INFO  [forge] child forge name=kid line="forge shutting down"',
    "",
  ].join("\n");
  expect(JSON.parse(resultLine(out))).toEqual({ placement: "cell", status: 200, body: "bakery says hi", app: "bakery" });
  expect(resultLine('{"skipped":"no bwrap"}\n')).toBe('{"skipped":"no bwrap"}');
  expect(resultLine("{ not json\nonly logs\n")).toBe("");
  expect(resultLine("")).toBe("");
});
