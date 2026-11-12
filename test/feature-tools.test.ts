/**
 * An absorbed app's declared MCP tools are served inside `/mcp` through the
 * `features` tool (no new tool): declared in forge.json, listed with the
 * feature, called over loopback, refused unless absorbed and declared.
 */

import { describe, expect, test } from "bun:test";
import { callTool, parseTools } from "../src/apps/feature_tools.ts";
import { parseFeature } from "../src/apps/feature.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

describe("declaring tools", () => {
  test("a feature carries its tools, writing unless it says otherwise", () => {
    const parsed = parseFeature({ feature: { name: "Radar", tools: { scan: { description: "Run a scan" }, latest: { description: "Last findings", writes: false } } } });
    expect(parsed.ok && parsed.value?.tools).toEqual([
      { name: "scan", description: "Run a scan", writes: true },
      { name: "latest", description: "Last findings", writes: false },
    ]);
    const none = parseFeature({ feature: { name: "Radar" } });
    expect(none.ok && none.value?.tools).toEqual([]);
  });

  test("a wrong tool is refused with its name", () => {
    expect(parseTools({ Scan: { description: "x" } }).ok).toBe(false);
    expect(parseTools({ scan: {} }).ok).toBe(false);
    expect(parseTools({ scan: { description: "x", writes: "no" } }).ok).toBe(false);
    expect(parseTools({ scan: { description: "x", url: "/x" } }).ok).toBe(false);
    expect(parseTools([]).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`t${i}`, { description: "x" }]));
    expect(parseTools(many).ok).toBe(false);
    const r = parseFeature({ feature: { name: "Radar", tools: { bad: 1 } } });
    expect(!r.ok && r.error).toContain("tool bad");
  });

  test("no tool was added to /mcp for it", () => {
    expect(TOOLS.some((t) => t.name.startsWith("feature_"))).toBe(false);
  });
});

describe("calling a tool on the app", () => {
  const serveApp = (handler: (req: Request) => Response | Promise<Response>) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });

  test("posts the args to /forge/tools/<name> and returns the JSON", async () => {
    let seen = "";
    const s = serveApp(async (req) => {
      seen = `${req.method} ${new URL(req.url).pathname} ${await req.text()}`;
      return Response.json({ found: 3 });
    });
    try {
      const out = await callTool(s.port!, "scan", { depth: 2 });
      expect(out).toEqual({ ok: true, value: { found: 3 } });
      expect(seen).toBe('POST /forge/tools/scan {"args":{"depth":2}}');
    } finally {
      s.stop(true);
    }
  });

  test("a failing, non-JSON, oversized or absent app is an error, not a crash", async () => {
    const bad = serveApp((req) => {
      const p = new URL(req.url).pathname;
      if (p.endsWith("/boom")) return new Response("no", { status: 500 });
      if (p.endsWith("/text")) return new Response("hello");
      return new Response("x".repeat(70 * 1024));
    });
    try {
      expect((await callTool(bad.port!, "boom", {})).ok).toBe(false);
      expect((await callTool(bad.port!, "text", {})).ok).toBe(false);
      const big = await callTool(bad.port!, "big", {});
      expect(!big.ok && big.error).toContain("64 KB");
    } finally {
      bad.stop(true);
    }
    expect((await callTool(1, "scan", {})).ok).toBe(false);
  });
});
