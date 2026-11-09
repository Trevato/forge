/**
 * `GET /fleet`: the rows `fleet/selection.ts` selects, as a table. Render,
 * a parse error beside the query line, sorting through header links, a
 * private repository absent for a visitor, escaping, a 1,000-row table
 * in full, and a page whose SQL does not grow with its rows (counted work,
 * not a clock: #7824).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { FleetRow } from "../src/fleet/rows.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readSort, sortRows } from "../src/fleet/columns.ts";
import { fleetTable } from "../src/web/fleet-table.ts";
import { promote } from "./helpers/members.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

describe("the fleet table", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let aliceCookie: string;

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      allowReserved: true,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const repoOf = async (owner: User, name: string, visibility: "public" | "private") => {
    const made = await createRepo(app, owner, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    await updateRepoSettings(app, owner, made.value, {
      autonomy: "assisted",
      autonomyBy: owner.id,
    });
    return made.value;
  };
  const get = (path: string, cookie?: string) =>
    fetch(`${servers.url}${path}`, cookie ? { headers: { cookie } } : {});
  const rowsOf = (body: string) => Number(body.match(/data-count="(\d+)"/)?.[1] ?? -1);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fleet-table-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await person("root", true);
    alice = await person("alice");
    await repoOf(alice, "engine", "private");
    await repoOf(alice, "tools", "public");
    await repoOf(alice, "atlas", "public");
    aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("renders the selected rows with a count, and the security headers", async () => {
    const res = await get(`/fleet?${new URLSearchParams({ q: "repo autonomy:assisted" })}`, aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    const body = await res.text();
    expect(rowsOf(body)).toBe(3);
    for (const name of ["alice/engine", "alice/tools", "alice/atlas"])
      expect(body).toContain(`href="/${name}"`);
    expect(body).toContain('<th scope="col"><a href="/fleet?q=repo+autonomy%3Aassisted&amp;sort=autonomy">');
  });

  test("an empty query line selects nothing and offers an example", async () => {
    const body = await (await get("/fleet")).text();
    expect(body).toContain('name="q"');
    expect(body).not.toContain("data-count=");
    // The grammar is listed under the query line (#566).
    const grammar = body.slice(body.indexOf("data-grammar"));
    expect(grammar).toContain("<code>run state:queued,running cost:&gt;0.5</code>");
    expect(grammar).toContain("<code>issue created:&lt;7d assignee:none</code>");
    // One row a kind naming its fields, never a middot-joined paragraph.
    expect(grammar).toMatch(/<dt class="mono">run<\/dt><dd>repo, [^<]*cost, created<\/dd>/);
    expect(grammar).toMatch(/<dt class="mono">issue<\/dt><dd>repo, [^<]*number, created, updated<\/dd>/);
    expect(grammar.slice(0, grammar.indexOf("</div>"))).not.toContain("·");
  });

  test("a query that does not parse shows its error beside the line, status 200, nothing selected", async () => {
    const res = await get(`/fleet?${new URLSearchParams({ q: "repo spent:4" })}`, aliceCookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain("repo has no field &quot;spent&quot;");
    expect(body).not.toContain("data-count=");
    expect(body).not.toContain("<table");
  });

  test("sorts by one column through the header links, and flips on the second click", async () => {
    const order = async (sort: string) => {
      const body = await (
        await get(`/fleet?${new URLSearchParams({ q: "repo owner:alice", sort })}`, aliceCookie)
      ).text();
      return [...body.matchAll(/<td><a href="\/(alice\/\w+)">/g)].map((m) => m[1]);
    };
    expect(await order("repo")).toEqual(["alice/atlas", "alice/engine", "alice/tools"]);
    expect(await order("-repo")).toEqual(["alice/tools", "alice/engine", "alice/atlas"]);
    // private before public; ties keep the selection's own order.
    expect(await order("visibility")).toEqual(["alice/engine", "alice/atlas", "alice/tools"]);
    const body = await (
      await get(`/fleet?${new URLSearchParams({ q: "repo owner:alice", sort: "repo" })}`, aliceCookie)
    ).text();
    expect(body).toContain('aria-sort="ascending"><a href="/fleet?q=repo+owner%3Aalice&amp;sort=-repo"');
    expect(readSort("repo", "nonsense")).toBeUndefined();
    expect(readSort("repo", "-app")).toEqual({ key: "app", descending: true });
  });

  test("a private repository is absent for a visitor, present for its owner", async () => {
    const q = `/fleet?${new URLSearchParams({ q: "repo owner:alice" })}`;
    const visitor = await (await get(q)).text();
    expect(rowsOf(visitor)).toBe(2);
    expect(visitor).not.toContain("alice/engine");
    const owner = await (await get(q, aliceCookie)).text();
    expect(rowsOf(owner)).toBe(3);
    expect(owner).toContain("alice/engine");
  });

  test("every cell is escaped", () => {
    const rows: FleetRow[] = [
      { id: "1", repo: "a/b", number: 1, title: "<script>alert(1)</script>", state: "open", assignee: '"x"' },
    ];
    const out = String(fleetTable("issue", "issue <b>", rows, undefined));
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&quot;x&quot;");
    expect(out).not.toContain("<b>");
  });

  test("a 1,000-row selection renders every row, sorted", () => {
    const rows: FleetRow[] = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      created: `2026-11-09T00:00:${String(i % 60).padStart(2, "0")}Z`,
      repo: `owner${i % 37}/repo${i}`,
      kind: "agent",
      agent: `agent${i % 5}`,
      state: i % 3 === 0 ? "failed" : "ok",
      cost: (i * 7) % 13,
    }));
    const out = String(fleetTable("run", "run", rows, { key: "cost", descending: true }));
    expect((out.match(/<tr>/g) ?? []).length).toBe(1001);
    expect(out.indexOf("$12.00")).toBeLessThan(out.indexOf("$0.00"));
    expect(sortRows(rows, { key: "cost", descending: false })[0]!.cost).toBe(0);
  });

  test("the page's SQL does not grow with its rows", async () => {
    const url = (q: string) => `${servers.url}/fleet?${new URLSearchParams({ q })}`;
    const init = { headers: { cookie: aliceCookie } };
    await requestStatements(app.db, url("repo name:atlas"), init); // warm
    const one = await requestStatements(app.db, url("repo name:atlas"), init);
    const three = await requestStatements(app.db, url("repo owner:alice"), init);
    expectWork(three, { max: one });
  });
});
