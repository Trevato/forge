import { afterAll, describe, expect, test } from "bun:test";
import { outboundFetch, vetHost, type Resolve } from "../src/kernel/outbound.ts";
import { selfSigned } from "./helpers/gate-fixture.ts";

const to = (...a: string[]): Resolve => () => Promise.resolve(a);

describe("vetHost", () => {
  for (const addr of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.5",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])
    test(`refuses ${addr}`, async () => {
      const r = await vetHost(addr);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("refused");
    });

  test("refuses a public name that resolves to 127.0.0.1", async () => {
    const r = await vetHost("hooks.example.com", { resolve: to("127.0.0.1") });
    expect(r).toEqual({ ok: false, error: "refused" });
  });

  test("refuses when any one answer is private", async () => {
    const r = await vetHost("x.example.com", { resolve: to("93.184.216.34", "10.0.0.1") });
    expect(r.ok).toBe(false);
  });

  test("allows a public address", async () => {
    const r = await vetHost("hooks.example.com", { resolve: to("93.184.216.34") });
    expect(r).toEqual({ ok: true, value: { via: "pin", addresses: ["93.184.216.34"] } });
  });

  test("a failed lookup is unresolved, not allowed", async () => {
    const r = await vetHost("nope.example.com", { resolve: () => Promise.reject(new Error("x")) });
    expect(r).toEqual({ ok: false, error: "unresolved" });
  });
});

describe("outboundFetch", () => {
  const seen: { host: string | null; path: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ host: req.headers.get("host"), path: new URL(req.url).pathname });
      if (new URL(req.url).pathname === "/redir")
        return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/secret" } });
      return new Response("ok");
    },
  });
  afterAll(() => server.stop(true));
  const allow = ["127.0.0.1"];

  test("throws before connecting to a private address", async () => {
    const before = seen.length;
    await expect(
      outboundFetch(`http://hooks.example.com:${server.port}/x`, {}, { resolve: to("127.0.0.1"), plain: true }),
    ).rejects.toThrow("refused: private address");
    expect(seen.length).toBe(before);
  });

  test("connects to the vetted address and keeps the name in Host", async () => {
    const res = await outboundFetch(
      `http://hooks.example.com:${server.port}/x`,
      {},
      { resolve: to("127.0.0.1"), allow, plain: true },
    );
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toEqual({ host: `hooks.example.com:${server.port}`, path: "/x" });
  });

  test("a 302 to a private address is returned, not followed", async () => {
    const res = await outboundFetch(
      `http://hooks.example.com:${server.port}/redir`,
      {},
      { resolve: to("127.0.0.1"), allow, plain: true },
    );
    expect(res.status).toBe(302);
    expect(seen.filter((s) => s.path === "/secret")).toHaveLength(0);
  });
});

describe("outboundFetch over https", () => {
  const pair = selfSigned("hooks.example.com");
  const t = pair ? test : test.skip;
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterAll(() => servers.forEach((s) => s.stop(true)));
  const serveTls = () => {
    const s = Bun.serve({ port: 0, tls: { cert: pair!.cert, key: pair!.key }, fetch: () => new Response("secure") });
    servers.push(s);
    return s;
  };
  const opts = { resolve: to("127.0.0.1"), allow: ["127.0.0.1"], ca: pair?.cert };

  t("connects to the judged address and checks the certificate against the name", async () => {
    const s = serveTls();
    const res = await outboundFetch(`https://hooks.example.com:${s.port}/x`, {}, opts);
    expect(await res.text()).toBe("secure");
  });

  t("fails when the certificate is not for the name", async () => {
    const s = serveTls();
    await expect(outboundFetch(`https://other.example.com:${s.port}/x`, {}, opts)).rejects.toThrow();
  });

  t("is not trusted without the CA", async () => {
    const s = serveTls();
    await expect(
      outboundFetch(`https://hooks.example.com:${s.port}/x`, {}, { ...opts, ca: undefined }),
    ).rejects.toThrow();
  });
});

describe("outboundFetch refuses plain http", () => {
  test("before resolving anything", async () => {
    let looked = false;
    await expect(
      outboundFetch("http://hooks.example.com/x", {}, { resolve: () => ((looked = true), to("93.184.216.34")("")) }),
    ).rejects.toThrow("refused: not https");
    expect(looked).toBe(false);
  });
});
