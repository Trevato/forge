import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { discover } from "../src/origins/discover.ts";
import { providerFor } from "../src/origins/providers/index.ts";
import { staticCredential } from "../src/origins/types.ts";

/**
 * A forge on 0.5.x, as one really answers (#9388): no `/api/v1/version`, no
 * NodeInfo, no `/api/v1/user/repos`; but `/api/v1/health`, `/api/v1/here`,
 * `/api/v1/user` and the cursor-paged `/api/v1/repos` in a forge's own JSON.
 */

const TOKEN = "friend-token";
const repo = (id: number, owner: string, name: string, visibility: string) => ({
  id: String(id),
  ownerName: owner,
  name,
  description: `${name} app`,
  visibility,
  forkParentId: null,
  defaultBranch: "main",
});
const ALL = [
  repo(1, "zed", "other", "public"),
  repo(2, "ben", "notes", "public"),
  repo(3, "ben", "secret", "private"),
  repo(4, "zed", "more", "public"),
  repo(5, "ben", "clock", "public"),
];

let server: ReturnType<typeof Bun.serve>;
let base = "";
const seen: string[] = [];

beforeAll(() => {
  process.env.FORGE_DEV = "1";
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname + url.search);
      const json = (v: unknown) => Response.json(v);
      if (url.pathname === "/api/v1/health")
        return json({ ok: true, version: "0.5.29", commit: "abc1234", draining: false });
      if (url.pathname === "/api/v1/here")
        return json({ here: { kind: "forge", name: "/" }, you: null, actions: [], mcp: {}, docs: [] });
      // A forge before `token <secret>` was taught reads Bearer and Basic only.
      const authed = req.headers.get("authorization") === `Bearer ${TOKEN}`;
      if (url.pathname === "/api/v1/user")
        return authed ? json({ username: "ben", displayName: "Ben" }) : new Response("{}", { status: 401 });
      if (url.pathname === "/api/v1/repos") {
        if (!authed) return new Response("{}", { status: 401 });
        const after = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const rows = ALL.filter((r) => Number(r.id) > after).slice(0, limit);
        const last = rows[rows.length - 1];
        return json({ items: rows, next_cursor: rows.length >= limit && last ? last.id : null });
      }
      return new Response('{"error":"no_route"}', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe("a forge on an older release", () => {
  test("discover recognises it through health and here", async () => {
    const found = await discover(base);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.via).toBe("health");
    expect(found.value.software).toBe("forge 0.5.29");
    expect(seen).toContain("/api/v1/version");
  });

  test("something that answers health but is no forge is not one", async () => {
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/api/v1/health" ? Response.json({ ok: true }) : new Response("no", { status: 404 }),
    });
    const found = await discover(`http://127.0.0.1:${other.port}`);
    other.stop(true);
    expect(found.ok).toBe(false);
  });

  test("provider forge lists the account's own repositories, private ones too", async () => {
    const provider = providerFor(
      staticCredential({
        kind: "gitea",
        software: "forge",
        apiUrl: `${base}/api/v1`,
        webUrl: base,
        login: "ben",
        token: TOKEN,
      }),
    );
    const page = await provider.listRepos();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.items.map((r) => [r.fullName, r.private])).toEqual([
      ["ben/notes", false],
      ["ben/secret", true],
      ["ben/clock", false],
    ]);
    expect(page.value.next).toBeNull();
  });
});
