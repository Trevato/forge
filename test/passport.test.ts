import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { forgetKey } from "../src/kernel/secret.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issue, MAX_TTL_MS, verify } from "../src/kernel/passport.ts";

const dir = () => mkdtempSync(join(tmpdir(), "passport-"));
const base = { iss: "forge", aud: "runner", scopes: ["run:read"], ttlMs: 60_000, now: 1000 };
const want = { audience: "runner", scope: "run:read", now: 2000 };
const mint = (d: string, o = {}) => {
  const r = issue(d, { ...base, ...o });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

test("a fresh passport verifies for its audience and scope", () => {
  const d = dir();
  const r = verify(d, mint(d), want);
  expect(r.ok && r.value.iss).toBe("forge");
});

test("expiry is enforced", () => {
  const d = dir();
  const r = verify(d, mint(d), { ...want, now: 61_000 });
  expect(!r.ok && r.error).toBe("expired");
});

test("another audience or an unlisted scope is refused", () => {
  const d = dir();
  const t = mint(d);
  const a = verify(d, t, { ...want, audience: "app" });
  const s = verify(d, t, { ...want, scope: "run:write" });
  expect(!a.ok && a.error).toBe("wrong_audience");
  expect(!s.ok && s.error).toBe("missing_scope");
});

test("a tampered payload or another forge's key is refused", () => {
  const d = dir();
  const t = mint(d);
  const [p, , sig] = t.split(".") as [string, string, string];
  const forged = Buffer.from(
    JSON.stringify({ iss: "forge", aud: "runner", scopes: ["admin"], exp: 9e12 }),
  ).toString("base64url");
  const r = verify(d, `${p}.${forged}.${sig}`, { ...want, scope: "admin" });
  expect(!r.ok && r.error).toBe("bad_signature");
  const other = verify(dir(), t, want);
  expect(!other.ok && other.error).toBe("bad_signature");
});

test("garbage is bad_format", () => {
  const d = dir();
  for (const t of ["", "x", "fp1.a", "fp2.a.b", "a.b.c.d", "x".repeat(3000)]) {
    const r = verify(d, t, want);
    expect(!r.ok && r.error).toBe("bad_format");
  }
});

test("issue validates names, scopes and ttl", () => {
  const d = dir();
  const e = (o: object) => {
    const r = issue(d, { ...base, ...o });
    return !r.ok && r.error;
  };
  expect(e({ aud: "Bad Name" })).toBe("bad_name");
  expect(e({ scopes: [] })).toBe("bad_scopes");
  expect(e({ scopes: ["ok", "no spaces"] })).toBe("bad_scopes");
  expect(e({ ttlMs: 0 })).toBe("bad_ttl");
  expect(e({ ttlMs: MAX_TTL_MS + 1 })).toBe("bad_ttl");
  expect(e({ ttlMs: NaN })).toBe("bad_ttl");
});

test("rotating the key file stops old passports verifying", () => {
  const d = dir();
  const t = mint(d);
  expect(verify(d, t, want).ok).toBe(true);
  writeFileSync(join(d, "secret.key"), randomBytes(32), { mode: 0o600 });
  forgetKey(d);
  const r = verify(d, t, want);
  expect(!r.ok && r.error).toBe("bad_signature");
});
