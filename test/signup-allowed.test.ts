/**
 * signupAllowed holds two windows: a source may sign up five times a minute,
 * the forge sixty, whoever asks. A refused call is not counted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { notePeer } from "../src/http/peer.ts";
import { LIMITS, LIMIT_KEYS } from "../src/settings/limits.ts";
import { signupAllowed } from "../src/web/pages/site.ts";
import type { Ctx } from "../src/http/context.ts";

describe("signupAllowed", () => {
  let dataDir: string;
  let app: App;

  const from = (address: string, forge: App = app): number | undefined => {
    const request = new Request("http://forge.local/signup");
    notePeer(request, address);
    return signupAllowed({ app: forge, request } as unknown as Ctx);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signup-allowed-"));
    app = createApp({ dataDir, port: 0 });
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the limits are listed with production defaults", () => {
    expect(LIMIT_KEYS).toContain("signup.per_source");
    expect(LIMIT_KEYS).toContain("signup.per_forge");
    expect(LIMITS["signup.per_source"].default).toBe(5);
    expect(LIMITS["signup.per_forge"].default).toBe(60);
  });

  test("rapid calls from one source are throttled, another source is not", () => {
    for (let i = 0; i < 5; i++) expect(from("203.0.113.1")).toBeUndefined();
    const wait = from("203.0.113.1");
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(from("203.0.113.2")).toBeUndefined();
  });

  test("the per-forge window holds across sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-signup-allowed-"));
    const forge = createApp({ dataDir: dir, port: 0 });
    try {
      // Sixty sources, one sign-up each, fill the forge's window.
      for (let i = 0; i < 60; i++) expect(from(`198.51.100.${i + 1}`, forge)).toBeUndefined();
      expect(from("192.0.2.200", forge)).toBeGreaterThan(0);
    } finally {
      forge.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
