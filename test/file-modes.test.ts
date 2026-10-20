/** Host keys and database files are 0600; too-open ones are refused or named (#3025). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { forgeVitals } from "../src/actions/health.ts";
import { loadOrCreateHostKey } from "../src/ssh/keys.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "forge-modes-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;

test("a fresh host key is 0600, and a 0640 one is refused with the path and mode", () => {
  const dir = tmp();
  loadOrCreateHostKey(dir);
  expect(mode(join(dir, "host_ed25519"))).toBe(0o600);
  chmodSync(join(dir, "host_ed25519"), 0o640);
  expect(() => loadOrCreateHostKey(dir)).toThrow(/host_ed25519 is mode 640; it must be 0600/);
  expect(mode(join(dir, "host_ed25519"))).toBe(0o640);
});

test("fresh database files are 0600", () => {
  const dataDir = tmp();
  const app = createApp({ dataDir, port: 0 });
  try {
    expect(mode(join(dataDir, "forge.db"))).toBe(0o600);
    for (const s of ["-wal", "-shm"]) {
      try {
        expect(mode(join(dataDir, "forge.db" + s))).toBe(0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    expect(forgeVitals(app).degraded.some((d) => d.cause.startsWith("file:"))).toBe(false);
  } finally {
    app.db.close();
  }
});

test("a 0644 forge.db is tightened to 0600 at boot, with its side files", () => {
  const dataDir = tmp();
  createApp({ dataDir, port: 0 }).db.close();
  chmodSync(join(dataDir, "forge.db"), 0o644);
  const app = createApp({ dataDir, port: 0 });
  try {
    expect(mode(join(dataDir, "forge.db"))).toBe(0o600);
    expect(forgeVitals(app).degraded.some((d) => d.cause.startsWith("file:"))).toBe(false);
  } finally {
    app.db.close();
  }
});
