import { expect, test } from "bun:test";
import { mayUse } from "../src/apps/cloud.ts";
import { parseCloud } from "../src/apps/manifest.ts";

const file = (uses: unknown) => JSON.stringify({ uses });
const s3 = { vendor: "s3", use: "backup", why: "off-machine copy" };

test("no file: every use is refused", () => {
  const r = parseCloud(undefined);
  expect(r.ok).toBe(true);
  if (r.ok) expect(mayUse(r.value, "s3", "backup")).toBe(false);
  expect(mayUse(undefined, "fly", "compute")).toBe(false);
});

test("a declared use is allowed, an undeclared one refused", () => {
  const r = parseCloud(file([s3]));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(mayUse(r.value, "s3", "backup")).toBe(true);
  expect(mayUse(r.value, "s3", "storage")).toBe(false);
  expect(mayUse(r.value, "fly", "backup")).toBe(false);
});

test("a malformed file is refused with a sentence", () => {
  for (const bad of [
    "nope",
    "[]",
    "{}",
    file("x"),
    file([{ ...s3, vendor: "acme" }]),
    file([{ ...s3, use: "mining" }]),
    file([{ ...s3, why: "" }]),
    file([{ ...s3, why: "a\nb" }]),
    file([42]),
  ]) {
    const r = parseCloud(bad);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "invalid")
      expect(r.error.message).toStartWith("cloud.json:");
  }
});
