import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { inCidrs, parseCidrs } from "../src/kernel/cidr.ts";
import {
  bucketOf,
  carryPeer,
  clientAddress,
  notePeer,
  resolveClient,
  type ProxyTrust,
} from "../src/http/peer.ts";
import { serve, type Servers } from "../src/http/server.ts";

const headers = (h: Record<string, string>) => new Headers(h);

describe("CIDR lists", () => {
  test("IPv4, IPv6, single addresses and IPv4-mapped IPv6", () => {
    const list = parseCidrs("10.42.0.0/16, 192.0.2.7, fd00::/8");
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(inCidrs("10.42.3.4", list.value)).toBe(true);
    expect(inCidrs("10.43.0.1", list.value)).toBe(false);
    expect(inCidrs("192.0.2.7", list.value)).toBe(true);
    expect(inCidrs("192.0.2.8", list.value)).toBe(false);
    expect(inCidrs("fd12::1", list.value)).toBe(true);
    expect(inCidrs("::ffff:10.42.9.9", list.value)).toBe(true);
    expect(inCidrs("not-an-ip", list.value)).toBe(false);
  });

  test("a malformed entry is refused, not ignored", () => {
    expect(parseCidrs("10.42.0.0/33").ok).toBe(false);
    expect(parseCidrs("10.42.0/16").ok).toBe(false);
    expect(parseCidrs("example.com").ok).toBe(false);
    expect(parseCidrs("").ok).toBe(true);
  });
});

describe("the client behind the proxy", () => {
  const trust = (proxies: string, header?: string): ProxyTrust => {
    const parsed = parseCidrs(proxies);
    if (!parsed.ok) throw new Error("cidr");
    return { proxies: parsed.value, ...(header ? { header } : {}) };
  };
  const ingress = trust("10.42.0.0/16");

  test("with no setting, a public peer is the client and headers are ignored", () => {
    const none = trust("");
    expect(
      resolveClient(
        "203.0.113.5",
        headers({ "x-forwarded-for": "198.51.100.1" }),
        none,
      ),
    ).toBe("203.0.113.5");
  });

  test("a trusted proxy's forwarded hop separates two clients", () => {
    const a = resolveClient(
      "10.42.0.166",
      headers({ "x-forwarded-for": "198.51.100.1" }),
      ingress,
    );
    const b = resolveClient(
      "10.42.0.166",
      headers({ "x-forwarded-for": "198.51.100.2" }),
      ingress,
    );
    expect(a).toBe("198.51.100.1");
    expect(b).toBe("198.51.100.2");
  });

  test("the same header from a peer that is not trusted is ignored", () => {
    expect(
      resolveClient(
        "203.0.113.5",
        headers({ "x-forwarded-for": "198.51.100.1" }),
        ingress,
      ),
    ).toBe("203.0.113.5");
  });

  test("a hop the client wrote cannot choose its bucket", () => {
    // The client sent "1.1.1.1"; the ingress appended the address it saw.
    const got = resolveClient(
      "10.42.0.166",
      headers({ "x-forwarded-for": "1.1.1.1, 198.51.100.9" }),
      ingress,
    );
    expect(got).toBe("198.51.100.9");
  });

  test("a chain of trusted proxies is walked from the right", () => {
    // client → tunnel (10.42.0.79) → ingress (10.42.0.166) → forge
    const got = resolveClient(
      "10.42.0.166",
      headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 10.42.0.79" }),
      ingress,
    );
    expect(got).toBe("198.51.100.4");
  });

  test("a named header is read only from a trusted proxy", () => {
    const cf = trust("10.42.0.0/16", "cf-connecting-ip");
    expect(
      resolveClient(
        "10.42.0.166",
        headers({
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-for": "10.42.0.79",
        }),
        cf,
      ),
    ).toBe("198.51.100.7");
    expect(
      resolveClient(
        "203.0.113.5",
        headers({ "cf-connecting-ip": "198.51.100.7" }),
        cf,
      ),
    ).toBe("203.0.113.5");
    // A value that is not an address falls back to the forwarded walk.
    expect(
      resolveClient(
        "10.42.0.166",
        headers({
          "cf-connecting-ip": "evil",
          "x-forwarded-for": "198.51.100.8",
        }),
        cf,
      ),
    ).toBe("198.51.100.8");
  });

  test("this machine counts as a proxy, as before, but its hop is read from the right", () => {
    const none = trust("");
    expect(
      resolveClient(
        "127.0.0.1",
        headers({ "x-forwarded-for": "1.1.1.1, 198.51.100.3" }),
        none,
      ),
    ).toBe("198.51.100.3");
    expect(resolveClient("127.0.0.1", headers({}), none)).toBe("127.0.0.1");
  });
});

describe("this machine is not a proxy once the proxies are named", () => {
  const listed = (): ProxyTrust => {
    const parsed = parseCidrs("10.42.0.0/16");
    if (!parsed.ok) throw new Error("cidr");
    return { proxies: parsed.value, header: "cf-connecting-ip" };
  };

  test("an app on this machine cannot choose its address with forwarded headers", () => {
    // Every app and crew run is a process beside the forge: it can call
    // 127.0.0.1 and say anything. With the ingress listed, it is itself.
    const h = headers({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "2.2.2.2" });
    expect(resolveClient("127.0.0.1", h, listed())).toBe("127.0.0.1");
    expect(resolveClient("::1", h, listed())).toBe("::1");
  });

  test("this machine counts only when it is listed", () => {
    const parsed = parseCidrs("127.0.0.0/8");
    if (!parsed.ok) throw new Error("cidr");
    const h = headers({ "x-forwarded-for": "198.51.100.30" });
    expect(resolveClient("127.0.0.1", h, { proxies: parsed.value })).toBe("198.51.100.30");
  });

  test("with no proxies named, the named header is never read, even from this machine", () => {
    const h = headers({ "cf-connecting-ip": "2.2.2.2", "x-forwarded-for": "198.51.100.31" });
    expect(resolveClient("127.0.0.1", h, { proxies: [], header: "cf-connecting-ip" })).toBe("198.51.100.31");
  });
});

describe("limit keys", () => {
  test("an IPv6 client is keyed by its /64; IPv4 by its address", () => {
    expect(bucketOf("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(bucketOf("198.51.100.7")).toBe("198.51.100.7");
    expect(bucketOf("::ffff:198.51.100.7")).toBe("::ffff:198.51.100.7");
    expect(bucketOf("unknown")).toBe("unknown");
  });

  test("a replayed request keeps the client noted on the original", () => {
    const first = new Request("http://x/api/v1/repos", { method: "POST" });
    notePeer(first, "203.0.113.40");
    const again = new Request("http://x/api/v1/repos", { method: "POST" });
    expect(clientAddress(again)).toBe("unknown");
    carryPeer(first, again);
    expect(clientAddress(again)).toBe("203.0.113.40");
  });
});

// Two outside clients behind the trusted ingress are counted apart by the
// limiter on reports from outside.
describe("limits see each outside client", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-client-addr-"));
    // The test client is this machine, over either loopback: name both, as
    // an operator must once proxies are named.
    app = createApp({ dataDir, port: 0, trustedProxies: ["127.0.0.0/8", "::1"] });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the OAuth registration limiter counts two forwarded clients apart", async () => {
    const register = (client: string) =>
      fetch(`${servers.url}/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": client,
        },
        body: JSON.stringify({
          client_name: "c",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        }),
      });
    // One client spends its whole minute…
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await register("198.51.100.20")).status;
    expect(last).toBe(429);
    // …and another, behind the same proxy, is not refused for it.
    expect((await register("198.51.100.21")).status).toBe(201);
  });
});
