/** The Worker front door: what the body is sent, and what is said when it is down. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-expect-error plain JS, deployed as is
import { Forge, forward } from "../infra/forge-cloudflare/worker.js";

describe("forge-cloudflare worker", () => {
  test("forward keeps path and query, swaps the origin, tells the public scheme", () => {
    const r = forward(
      new Request("https://spike-a.example.com/api/v1/x?y=1", { headers: { "cf-connecting-ip": "1.2.3.4" } }),
      "https://body.example.net",
    ) as Request;
    expect(r.url).toBe("https://body.example.net/api/v1/x?y=1");
    expect(r.headers.get("x-forwarded-host")).toBe("spike-a.example.com");
    expect(r.headers.get("x-forwarded-proto")).toBe("https");
    expect(r.headers.get("cf-connecting-ip")).toBeNull();
  });

  test("an unreachable body is a 503 on /healthz and a 502 elsewhere", async () => {
    const f = new Forge({}, { BODY_URL: "http://127.0.0.1:1" });
    expect((await f.fetch(new Request("https://h/healthz"))).status).toBe(503);
    expect((await f.fetch(new Request("https://h/mcp"))).status).toBe(502);
  });

  test("the module refuses names outside the spike- prefix", () => {
    const v = readFileSync("infra/forge-cloudflare/variables.tf", "utf8");
    expect(v).toContain('^spike-[a-z0-9-]{1,40}$');
  });
});
