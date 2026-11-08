import { expect, test } from "bun:test";

const oid = "a".repeat(40);
const run = async (status: number) => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url).pathname;
      if (!u.includes(oid)) return new Response(`<a href="/o/r/blob/${oid}/f.txt">f</a>`, { headers: { "content-type": "text/html" } });
      return new Response("x", { status, headers: { "server-timing": "git;dur=2.5, session;dur=0.5" } });
    },
  });
  try {
    const p = Bun.spawn(["bun", "bench/code-phases.ts", "--url", `http://127.0.0.1:${server.port}`, "--repo", "o/r", "--rate", "50", "--seconds", "1"], { stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, out: await new Response(p.stdout).text() };
  } finally {
    server.stop(true);
  }
};

test("served pages are profiled; refusals are counted by status, not tallied", async () => {
  const ok = await run(200);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("not counted as samples (by status): none");
  expect(ok.out).toMatch(/\| blob \| git \| \d+ \| 2\.5 \| 2\.5 \|/);
  const no = await run(404);
  expect(no.out).toMatch(/not counted as samples \(by status\): 404: \d+/);
  expect(no.out).toMatch(/\| blob \| wall \| 0 \| – \| – \|/);
});
