import { expect, test } from "bun:test";
import { foldStacks, frameLine } from "../src/perf/sample.ts";

test("traces fold into counted stacks, most frequent first", () => {
  const a = { frames: [{ name: "hot", sourceURL: "/x/src/a.ts", line: 3 }] };
  const b = { frames: [{ name: "cold", sourceURL: "/x/src/b.ts", line: 9 }] };
  const stacks = foldStacks({ traces: [b, a, a] });
  expect(stacks).toEqual([
    { count: 2, stack: "hot (src/a.ts:3)" },
    { count: 1, stack: "cold (src/b.ts:9)" },
  ]);
  expect(frameLine({ sourceURL: "/x/y.ts", line: 4294967295 })).toBe("(anonymous) (x/y.ts)");
});

// In a child: the profiler cannot be stopped, and would linger in this test process.
test("a sample sees the busy function, and a second at once is refused", async () => {
  const script = `
    import { sampleStacks } from ${JSON.stringify(new URL("../src/perf/sample.ts", import.meta.url).pathname)};
    const first = sampleStacks(1);
    const second = await sampleStacks(1);
    const stop = Date.now() + 700;
    let x = 0;
    const spin = () => { while (Date.now() < stop) x += Math.sqrt(x + 1); };
    await new Promise((r) => setTimeout(r, 50));
    spin();
    console.log(JSON.stringify({ second: second ?? null, first: await first }));`;
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
  const out = JSON.parse(await new Response(child.stdout).text()) as {
    second: unknown;
    first: { seconds: number; samples: number; stacks: { stack: string }[] };
  };
  expect(out.second).toBeNull();
  expect(out.first.seconds).toBe(1);
  expect(out.first.samples).toBeGreaterThan(0);
  expect(out.first.stacks.some((s) => s.stack.includes("spin"))).toBe(true);
});
