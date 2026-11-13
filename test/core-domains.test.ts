/**
 * The proxy serves only verified domains (#6791): `getVerifiedDomain` is
 * the one lookup it trusts, so an unverified host, a near-miss spelling and
 * a subdomain of a verified host are all refused, and a removed host goes.
 */
import { expect, test } from "bun:test";
import {
  addDomain,
  getVerifiedDomain,
  getDomain,
  listDomains,
  parseRecordsInput,
  setOldRecords,
  primaryDomain,
  recordCheck,
  removeDomain,
  type DomainRules,
} from "../src/core/domains.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

const RULES: DomainRules = { forgeHost: "forge.test" };

function fresh() {
  const db = openDb(":memory:", migrations);
  // Domains are rows of their own; the app they belong to is not under test.
  db.run("PRAGMA foreign_keys = OFF");
  return db;
}

const add = (db: ReturnType<typeof fresh>, host: string, appId = "a1") => {
  const r = addDomain(db, { host, appId }, RULES);
  if (!r.ok) throw new Error(`add ${host}: ${r.error}`);
  return r.value;
};

test("an unverified host is listed but not served; a passing check serves it", () => {
  const db = fresh();
  add(db, "app.example.com");
  expect(listDomains(db, "a1").map((d) => d.host)).toEqual(["app.example.com"]);
  expect(getVerifiedDomain(db, "app.example.com")).toBeUndefined();

  recordCheck(db, "app.example.com", { verified: false, said: "no record" });
  expect(getVerifiedDomain(db, "app.example.com")).toBeUndefined();

  recordCheck(db, "app.example.com", { verified: true, said: "ok" });
  expect(getVerifiedDomain(db, "app.example.com")?.host).toBe("app.example.com");
});

test("a failing check after verification does not unserve the host", () => {
  const db = fresh();
  add(db, "app.example.com");
  recordCheck(db, "app.example.com", { verified: true, said: "ok" });
  const at = getVerifiedDomain(db, "app.example.com")!.verifiedAt;
  recordCheck(db, "app.example.com", { verified: false, said: "gone" });
  const still = getVerifiedDomain(db, "app.example.com");
  expect(still?.verifiedAt).toBe(at);
  expect(still?.said).toBe("gone");
});

test("the lookup is exact: case and a trailing dot fold, a subdomain does not", () => {
  const db = fresh();
  add(db, "example.com");
  recordCheck(db, "example.com", { verified: true, said: "ok" });
  expect(getVerifiedDomain(db, "EXAMPLE.com")?.host).toBe("example.com");
  expect(getVerifiedDomain(db, "example.com.")?.host).toBe("example.com");
  expect(getVerifiedDomain(db, "www.example.com")).toBeUndefined();
  expect(getVerifiedDomain(db, "a.b.example.com")).toBeUndefined();
  expect(getVerifiedDomain(db, "com")).toBeUndefined();
  expect(getVerifiedDomain(db, "xexample.com")).toBeUndefined();
});

test("primaryDomain names the verified one and removeDomain unserves it", () => {
  const db = fresh();
  add(db, "app.example.com");
  expect(primaryDomain(db, "a1")).toBeUndefined();
  recordCheck(db, "app.example.com", { verified: true, said: "ok" });
  expect(primaryDomain(db, "a1")?.host).toBe("app.example.com");
  expect(primaryDomain(db, "other")).toBeUndefined();

  expect(removeDomain(db, "app.example.com")).toBe(true);
  expect(getVerifiedDomain(db, "app.example.com")).toBeUndefined();
  expect(primaryDomain(db, "a1")).toBeUndefined();
  expect(listDomains(db, "a1")).toEqual([]);
  expect(removeDomain(db, "app.example.com")).toBe(false);
});

test("old records are checked at the boundary, kept with the row, and replaced whole", () => {
  const db = fresh();
  add(db, "shop.example.net");
  expect(getDomain(db, "shop.example.net")?.oldRecords).toEqual([]);
  const parsed = parseRecordsInput([{ type: "aaaa", name: " shop.example.net ", value: "2001:db8::1", ttl: 60 }]);
  expect(parsed).toEqual({ ok: true, value: [{ type: "AAAA", name: "shop.example.net", value: "2001:db8::1", ttl: 60 }] });
  for (const bad of ["x", [1], [{ type: "A", name: "", value: "v" }], [{ type: "A", name: "n", value: "v", ttl: 1.5 }], Array(51).fill({ type: "A", name: "n", value: "v" })])
    expect(parseRecordsInput(bad)).toEqual({ ok: false, error: "invalid_records" });
  if (!parsed.ok) throw new Error("unreachable");
  expect(setOldRecords(db, "Shop.Example.Net.", parsed.value)).toBe(true);
  expect(getDomain(db, "shop.example.net")?.oldRecords).toEqual(parsed.value);
  expect(setOldRecords(db, "none.example.net", parsed.value)).toBe(false);
});
