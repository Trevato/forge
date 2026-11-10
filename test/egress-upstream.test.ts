/**
 * A cell opened by a forge that itself runs in a cell (a child forge's
 * check, app or install step) has no route but the outer cell's proxy. The
 * inner proxy dials through it with CONNECT, so the hosts the outer cell
 * allows actually work, and the outer cell's policy still applies on top.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { meterEgress, resetEgressTotals, startEgress, upstreamProxy } from "../src/apps/egress.ts";

beforeEach(resetEgressTotals);
afterEach(resetEgressTotals);

const freeish = (): number => 20_000 + Math.floor(Math.random() * 20_000);

/** Send `lines` through the proxy at `port` on a raw socket; everything that came back. */
function through(port: number, first: string, then?: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    let sent = false;
    void Bun.connect<undefined>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          s.write(first);
        },
        data(s, chunk) {
          got += new TextDecoder().decode(chunk);
          if (then !== undefined && !sent && got.includes("\r\n\r\n") && got.startsWith("HTTP/1.1 200")) {
            sent = true;
            s.write(then);
          }
        },
        close() {
          resolve(got);
        },
      },
    });
  });
}

test("the inner proxy reaches an allowed host through the outer cell's proxy, not around it", async () => {
  const target = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s) {
        s.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
      },
    },
  });
  const outerPort = freeish();
  const innerPort = outerPort + 1;
  const outerLabel = `forge:kid-${outerPort}`;
  const dest = { host: "127.0.0.1", port: target.port };
  const outer = startEgress({ tcp: outerPort }, { hosts: [], origins: [dest], label: outerLabel });
  const inner = startEgress(
    { tcp: innerPort },
    { hosts: [], origins: [dest], label: `check:inner-${innerPort}`, upstream: { host: "127.0.0.1", port: outerPort } },
  );
  const viaOuter = meterEgress(outerLabel);
  try {
    const tunnelled = await through(
      innerPort,
      `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
    );
    expect(tunnelled).toStartWith("HTTP/1.1 200 Connection Established");
    expect(tunnelled).toEndWith("hello");
    const forwarded = await through(innerPort, `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    expect(forwarded).toEndWith("hello");
    // Both answers came back across the outer proxy.
    expect(viaOuter.stop()).toBeGreaterThan(10);
  } finally {
    inner.close();
    outer.close();
    target.stop(true);
  }
});

test("a host the inner policy allows but the outer cell refuses is refused, and nothing resolves inside", async () => {
  const outerPort = freeish();
  const innerPort = outerPort + 1;
  const outer = startEgress({ tcp: outerPort }, { hosts: [], origins: [] });
  const inner = startEgress(
    { tcp: innerPort },
    { hosts: ["registry.npmjs.org"], origins: [], upstream: { host: "127.0.0.1", port: outerPort } },
  );
  try {
    const answer = await through(innerPort, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n");
    expect(answer).toStartWith("HTTP/1.1 403");
    expect(answer).toContain("not reachable from this forge's cell");
    // The inner policy still refuses on its own, before the outer is asked.
    const own = await through(innerPort, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    expect(own).toStartWith("HTTP/1.1 403");
    expect(own).toContain("not in this repository's egress");
  } finally {
    inner.close();
    outer.close();
  }
});

test("the upstream is the cell's own loopback proxy, or nothing", () => {
  expect(upstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:3128" })).toEqual({ host: "127.0.0.1", port: 3128 });
  expect(upstreamProxy({ https_proxy: "http://127.0.0.1:3128" })).toEqual({ host: "127.0.0.1", port: 3128 });
  expect(upstreamProxy({})).toBeUndefined();
  expect(upstreamProxy({ HTTPS_PROXY: "http://proxy.corp.example:3128" })).toBeUndefined();
  expect(upstreamProxy({ HTTPS_PROXY: "https://127.0.0.1:3128" })).toBeUndefined();
  expect(upstreamProxy({ HTTPS_PROXY: "http://u:p@127.0.0.1:3128" })).toBeUndefined();
});

test("a payment host passes a child's inner proxy only when the app declares it, in enforce and in report mode", async () => {
  const connect = "CONNECT api.stripe.com:443 HTTP/1.1\r\nHost: api.stripe.com:443\r\n\r\n";
  for (const report of [false, true]) {
    const outerPort = freeish();
    const innerPort = outerPort + 1;
    // The outer cell allows nothing, so a request that gets past the inner policy is named by the outer's refusal.
    const outer = startEgress({ tcp: outerPort }, { hosts: [], origins: [] });
    const upstream = { host: "127.0.0.1", port: outerPort };
    const seen: string[] = [];
    const policy = (hosts: string[]) => ({ hosts, origins: [], upstream, ...(report ? { report: (h: string) => void seen.push(h) } : {}) });
    const declared = startEgress({ tcp: innerPort }, policy(["api.stripe.com"]));
    const undeclared = startEgress({ tcp: innerPort + 1 }, policy([]));
    try {
      expect(await through(innerPort, connect)).toContain("not reachable from this forge's cell");
      const refused = await through(innerPort + 1, connect);
      expect(refused).toStartWith("HTTP/1.1 403");
      expect(refused).toContain("not in this repository's egress");
      expect(seen).toEqual([]);
      // Report mode still lets another undeclared public host reach the outer proxy.
      if (report) expect(await through(innerPort + 1, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")).toContain("not reachable from this forge's cell");
    } finally {
      declared.close();
      undeclared.close();
      outer.close();
    }
  }
});
