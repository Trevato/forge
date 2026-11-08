import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { renderCard } from "../src/web/og/card.ts";

setDefaultTimeout(30_000);

describe("GET /og/site.svg", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-og-site-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });
  afterAll(async () => {
    await servers.stop?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("answers an SVG with the security headers", async () => {
    const res = await fetch(servers.url + "/og/site.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    const body = await res.text();
    expect(body).toStartWith("<svg");
    expect(body.trimEnd()).toEndWith("</svg>");
    expect(body).toContain("forge");
    expect(body).not.toContain("<script");
    // Well-formed: every tag opens and closes (Bun has no DOMParser).
    const stack: string[] = [];
    for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
      if (m[3]) continue;
      if (m[1]) expect(stack.pop()).toBe(m[2]!);
      else stack.push(m[2]!);
    }
    expect(stack).toEqual([]);
  });

  test("text drawn on a card is escaped, never markup", () => {
    // The site card is fixed text; the same renderer draws every card, so
    // hostile input to it is what a forge name would be.
    const svg = renderCard({
      kind: "page",
      title: "<script>alert(1)</script> & co",
      lines: ["a & b <img onerror=x>"],
    });
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<img");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  test("a second request is cacheable and revalidates to a 304", async () => {
    const first = await fetch(servers.url + "/og/site.svg");
    await first.text();
    const cc = first.headers.get("cache-control") ?? "";
    expect(cc).toContain("public");
    expect(cc).toMatch(/max-age=\d+/);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await fetch(servers.url + "/og/site.svg", {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
