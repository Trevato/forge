import { expect, test } from "bun:test";
import { costliestTools } from "./mcp-size-rank.ts";

test("costliestTools ranks whole entries, schema included, biggest first, five at most", () => {
  const tool = (name: string, pad: number) => ({
    name,
    description: "d",
    inputSchema: { type: "object", properties: { a: { description: "x".repeat(pad) } } },
  });
  const tools = [tool("a", 10), tool("b", 500), tool("c", 50), tool("d", 300), tool("e", 20), tool("f", 100), tool("g", 5)];
  const out = costliestTools(tools);
  expect(out.split(", ").map((s) => s.split(" ")[0])).toEqual(["b", "d", "f", "c", "e"]);
  expect(out).toMatch(/^b \(\d+ bytes\)/);
  expect(out).toContain(`b (${Buffer.byteLength(JSON.stringify(tools[1]))} bytes)`);
});
