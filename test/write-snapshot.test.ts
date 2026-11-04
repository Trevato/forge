/**
 * The snapshot mcp-write-scope compares (#9031): a stray write to a
 * timer-flushed counter outside `/mcp` makes it differ, and the test's own
 * `/mcp` rows growing does not. Held to the real router and the real schemas.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import routeTiming from "../src/core/migrations/20261019140000-route-timing.ts";
import usageCount from "../src/core/migrations/20261016130000-usage-count.ts";
import { mcpRoutes } from "../src/http/mcp.ts";
import { Router } from "../src/http/router.ts";
import { COUNTERS, MCP_PATTERN, ownCount, snapshot } from "./helpers/write-snapshot.ts";

const H = "2026-11-03T10";

function seeded(): Database {
  const db = new Database(":memory:");
  db.exec(routeTiming);
  db.exec(usageCount);
  db.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)");
  db.query("INSERT INTO route_timing VALUES (?1, ?2, 2, 1, 900)").run(H, "/api/v1/repos/:owner/:name");
  db.query("INSERT INTO route_timing VALUES (?1, ?2, 1, 3, 1200)").run(H, MCP_PATTERN);
  db.query("INSERT INTO usage_count VALUES (?1, ?2, 'GET', '2xx', 'user', 'api', 4)").run(H, "/api/v1/user");
  db.query("INSERT INTO usage_count VALUES (?1, ?2, 'POST', '2xx', 'user', 'mcp', 5)").run(H, MCP_PATTERN);
  return db;
}

describe("the write-scope snapshot", () => {
  test("its key for MCP traffic is the pattern the router files /mcp under", () => {
    const router = new Router<any>();
    mcpRoutes(router);
    expect(router.match("POST", "/mcp")?.pattern).toBe(MCP_PATTERN);
  });

  test("it orders each counter by that table's real primary key", () => {
    const db = seeded();
    for (const [table, key] of Object.entries(COUNTERS)) {
      const pk = db
        .query<{ name: string; pk: number }, []>(`SELECT name, pk FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`)
        .all()
        .map((c) => c.name);
      expect(key).toEqual(pk);
    }
  });

  test("an inserted row outside /mcp makes it differ", () => {
    for (const insert of [
      "INSERT INTO route_timing VALUES ('2026-11-03T10', '/healthz', 0, 1, 10)",
      "INSERT INTO usage_count VALUES ('2026-11-03T10', '/api/v1/user', 'POST', '2xx', 'user', 'api', 1)",
    ]) {
      const db = seeded();
      const before = snapshot(db);
      db.exec(insert);
      expect(snapshot(db)).not.toEqual(before);
    }
  });

  test("a changed or removed row outside /mcp makes it differ", () => {
    for (const write of [
      "UPDATE route_timing SET n = n + 1 WHERE pattern <> '/mcp'",
      "UPDATE usage_count SET n = n + 1 WHERE pattern <> '/mcp'",
      "DELETE FROM usage_count WHERE pattern <> '/mcp'",
    ]) {
      const db = seeded();
      const before = snapshot(db);
      db.exec(write);
      expect(snapshot(db)).not.toEqual(before);
    }
  });

  test("a row whose pattern only contains mcp is held exactly, not let grow", () => {
    const db = seeded();
    db.query("INSERT INTO route_timing VALUES (?1, '/api/v1/mcp-tools', 0, 1, 10)").run(H);
    const before = snapshot(db);
    db.exec("UPDATE route_timing SET n = n + 1 WHERE pattern = '/api/v1/mcp-tools'");
    expect(snapshot(db)).not.toEqual(before);
  });

  test("the /mcp rows growing, or a new hour's /mcp row, leave it equal and raise the own count", () => {
    const db = seeded();
    const before = snapshot(db);
    const counted = ownCount(db);
    db.exec("UPDATE route_timing SET n = n + 2, sum_us = sum_us + 50 WHERE pattern = '/mcp'");
    db.exec("UPDATE usage_count SET n = n + 2 WHERE pattern = '/mcp'");
    db.query("INSERT INTO route_timing VALUES ('2026-11-03T11', ?1, 1, 1, 400)").run(MCP_PATTERN);
    expect(snapshot(db)).toEqual(before);
    expect(ownCount(db)).toBe(counted + 5);
  });

  test("a new row in any other table changes its count", () => {
    const db = seeded();
    const before = snapshot(db);
    db.exec("INSERT INTO note (body) VALUES ('x')");
    expect(snapshot(db)).not.toEqual(before);
  });
});
