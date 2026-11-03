import { describe, expect, test } from "bun:test";
import { huntTarget } from "../src/hunt/hunt.ts";
import { linksIn } from "../src/hunt/links.ts";
import { inside, probe, type Fetcher } from "../src/hunt/probe.ts";

const BASE = "https://app.test";
type Page = { status?: number; body?: string; type?: string; location?: string };

const site = (pages: Record<string, Page>): { fetcher: Fetcher; methods: string[] } => {
  const methods: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    methods.push(String(init.method));
    const u = new URL(url);
    const page = pages[u.pathname + u.search] ?? pages[u.pathname] ?? { status: 404, body: "" };
    const headers: Record<string, string> = { "content-type": page.type ?? "text/html" };
    if (page.location) headers.location = page.location;
    return new Response(page.body ?? "", { status: page.status ?? 200, headers });
  };
  return { fetcher, methods };
};

const healthy: Record<string, Page> = {
  "/": { body: '<a href="/explore">Explore</a><a href="/">Home</a>' },
  "/signin": {},
  "/explore": {},
  "/apps": {},
  "/healthz": {},
  "/settings": { status: 303, location: "/signin?next=%2Fsettings" },
  "/new": { status: 303, location: "/signin?next=%2Fnew" },
  "/migrate": { status: 303, location: "/signin?next=%2Fmigrate" },
  "/review": { status: 303, location: "/signin?next=%2Freview" },
  "/contract/openapi.json": {
    type: "application/json",
    body: JSON.stringify({ paths: { "/api/v1/apps": { get: { responses: { "200": {} } } }, "/api/v1/x/{id}": { get: {} } } }),
  },
  "/api/v1/apps": { type: "application/json", body: "{}" },
};

describe("the hunter", () => {
  test("a healthy site has no findings, and only GET was sent", async () => {
    const { fetcher, methods } = site(healthy);
    const r = await huntTarget(BASE, fetcher);
    expect(r.findings).toEqual([]);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  test("a menu link that lands on / without being Home is found (#5844)", async () => {
    const { fetcher } = site({
      ...healthy,
      "/": { body: '<a href="/mine">Your repositories</a>' },
      "/mine": { status: 302, location: "/" },
    });
    const r = await huntTarget(BASE, fetcher);
    expect(r.findings.map((f) => f.key)).toContain("links.lands-home:/mine");
  });

  test("a 404 link, a 500 route and an open personal page are each found once", async () => {
    const { fetcher } = site({
      ...healthy,
      "/": { body: '<a href="/gone">Gone</a><a href="/gone">Gone again</a>' },
      "/settings": { status: 200 },
      "/api/v1/apps": { status: 500, type: "application/json", body: "{}" },
    });
    const keys = (await huntTarget(BASE, fetcher)).findings.map((f) => f.key);
    expect(keys).toContain("links.status:/gone");
    expect(keys).toContain("contract.no-500:/api/v1/apps");
    expect(keys).toContain("door.signin-redirect:/settings");
    expect(keys.filter((k) => k === "links.status:/gone")).toHaveLength(1);
  });

  test("each finding carries its detector's kind (#8969)", async () => {
    const { fetcher } = site({
      ...healthy,
      "/": { body: '<a href="/gone">Gone</a><a href="/mine">Your repositories</a>' },
      "/mine": { status: 302, location: "/" },
      "/settings": { status: 200 },
      "/api/v1/apps": { status: 500, type: "application/json", body: "{}" },
    });
    const kinds = Object.fromEntries((await huntTarget(BASE, fetcher)).findings.map((f) => [f.key, f.kind]));
    expect(kinds["door.signin-redirect:/settings"]).toBe("security");
    expect(kinds["links.status:/gone"]).toBe("broken-route");
    expect(kinds["contract.no-500:/api/v1/apps"]).toBe("broken-route");
    expect(kinds["links.lands-home:/mine"]).toBe("cosmetic");
  });

  test("it refuses a path off the target", async () => {
    const { fetcher } = site({});
    await expect(probe(BASE, fetcher).get("https://evil.test/x")).rejects.toThrow();
    expect(inside(BASE, "//evil.test/x")).toBeNull();
    expect(inside(BASE, "/a?b=1")).toBe("/a?b=1");
  });

  test("links are read with their labels", () => {
    expect(linksIn('<a class="x" href="/a?b=1&amp;c=2"><b>Hi</b> there</a><a href="#top">t</a>')).toEqual([
      { href: "/a?b=1&c=2", label: "Hi there" },
    ]);
  });
});

describe("more detectors", () => {
  const keys = async (over: Record<string, Page>) => (await huntTarget(BASE, site({ ...healthy, ...over }).fetcher)).findings.map((f) => f.key);

  test("a sign-in redirect with no way back is found", async () => {
    expect(await keys({ "/new": { status: 303, location: "/signin" } })).toContain("door.signin-next:/new");
  });

  test("a status the route does not document is found", async () => {
    expect(await keys({ "/api/v1/apps": { status: 201, type: "application/json", body: "{}" } })).toContain("contract.documented:/api/v1/apps");
  });

  test("an OpenAPI document that is not JSON is found", async () => {
    expect(await keys({ "/contract/openapi.json": { body: "<html>" } })).toContain("contract.openapi:/contract/openapi.json");
  });

  test("a public page that fails is found", async () => {
    expect(await keys({ "/explore": { status: 500 } })).toContain("door.public-page:/explore");
  });

  test("an unknown path that answers 200 is found", async () => {
    expect(await keys({ "/no-such-page-hunter": { status: 200 } })).toContain("door.unknown-404:/no-such-page-hunter");
  });

  test("a dead route is a finding and does not end the pass", async () => {
    const { fetcher } = site(healthy);
    const dying: Fetcher = (url, init) =>
      new URL(url).pathname === "/explore" ? Promise.reject(new Error("reset")) : fetcher(url, init);
    const r = await huntTarget(BASE, dying);
    expect(r.findings.map((f) => f.key)).toContain("door.public-page:/explore");
    expect((await probe(BASE, dying).get("/explore")).status).toBe(0);
  });

  test("a body is read only up to its bound", async () => {
    let pulled = 0;
    const endless: Fetcher = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled += 100_000;
            c.enqueue(new Uint8Array(100_000).fill(97));
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    const seen = await probe(BASE, endless).get("/");
    expect(seen.body.length).toBe(400_000);
    expect(pulled).toBeLessThan(1_000_000);
  });
});
