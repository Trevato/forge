import { afterAll, beforeAll, expect, test } from "bun:test";
import { discover } from "../src/origins/discover.ts";
import { providerFor } from "../src/origins/providers/index.ts";
import { staticCredential } from "../src/origins/types.ts";
import { FORGE_PULL_CHECK_NEEDS } from "../src/origins/words.ts";
import fixture from "./fixtures/forge-0.5.x.json";

/**
 * A 0.5.x forge (#9456), replayed from a fixture reconstructed by hand from that release's API shape; every
 * path it does not name answers 404. The two `pin:` tests are regression pins: discover and listRepos already
 * worked against 0.5.x on main and pass there unchanged. The pull-check tests cover the one change: an answer
 * with no `check` names the release it needs, and a current forge's answer, which always carries `check`
 * (`none` when nothing ran), still reads as its word.
 */
const current: Record<string, unknown> = {
  "/api/v1/repos/ben/notes/pulls/2": { number: 2, title: "Now", state: "open", headOid: "def", check: "none" },
  "/api/v1/repos/ben/notes/pulls/3": { number: 3, title: "Green", state: "open", headOid: "fed", check: "green" },
};
let server: ReturnType<typeof Bun.serve>;
let base = "";
const seen: string[] = [];
const open = fixture.open as Record<string, unknown>;
const authed = fixture.authed as Record<string, unknown>;

beforeAll(() => {
  process.env.FORGE_DEV = "1";
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      if (url.pathname in open) return Response.json(open[url.pathname]);
      const ok = req.headers.get("authorization") === `Bearer ${fixture.token}`;
      if (url.pathname in current) return ok ? Response.json(current[url.pathname]) : new Response("{}", { status: 401 });
      if (url.pathname in authed)
        return ok ? Response.json(authed[url.pathname]) : new Response("{}", { status: 401 });
      if (url.pathname === "/api/v1/repos") {
        if (!ok) return new Response("{}", { status: 401 });
        const after = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const rows = fixture.repos.filter((r) => Number(r.id) > after).slice(0, limit);
        const last = rows[rows.length - 1];
        return Response.json({ items: rows, next_cursor: rows.length >= limit && last ? last.id : null });
      }
      return new Response("{}", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const provider = () =>
  providerFor(
    staticCredential({
      kind: "gitea",
      software: "forge",
      apiUrl: `${base}/api/v1`,
      webUrl: base,
      login: "ben",
      token: fixture.token,
    }),
  );

test("pin: discover names the 0.5.x forge from its fixture, with no version endpoint", async () => {
  const found = await discover(base);
  expect(found.ok).toBe(true);
  if (!found.ok) return;
  expect(found.value.software).toBe("forge 0.5.29");
  expect(found.value.via).toBe("health");
});

test("pin: provider forge lists the account's repositories from the fixture, never /user/repos", async () => {
  const page = await provider().listRepos();
  expect(page.ok).toBe(true);
  if (!page.ok) return;
  expect(page.value.items.map((r) => r.fullName)).toEqual(["ben/notes", "ben/secret"]);
  expect(seen).toContain("/api/v1/repos");
});

test("a pull's check, which that release lacks, fails naming the version it needs", async () => {
  const check = await provider().getPullCheck?.("ben/notes", 1);
  if (check === undefined) throw new Error("no getPullCheck");
  expect(check.ok).toBe(false);
  if (check.ok) return;
  expect(check.error.message).toBe(FORGE_PULL_CHECK_NEEDS);
  expect(check.error.message).toContain("0.7.355");
});

test("a current forge's pull, whose check is the word none, still reads as none, not as an old forge", async () => {
  const p = provider();
  for (const [n, word, head] of [[2, "none", "def"], [3, "green", "fed"]] as const) {
    const check = await p.getPullCheck?.("ben/notes", n);
    expect(check).toEqual({ ok: true, value: { word, headOid: head } });
  }
});
