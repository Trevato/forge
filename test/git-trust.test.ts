/**
 * Git trusts what the runtime trusts: an extra certificate authority named
 * by `NODE_EXTRA_CA_CERTS` reaches every git subprocess as a bundle that
 * also keeps the system's own, so a private origin and a public one both
 * answer.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, trustedCaBundle } from "../src/git/env.ts";

const PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";

describe("git trusts the runtime's extra authority", () => {
  test("no extra authority: git keeps its own bundle", () => {
    expect(trustedCaBundle("")).toBeUndefined();
  });

  test("an extra authority is added on top of the system bundle, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-ca-"));
    const extra = join(dir, "private-ca.crt");
    writeFileSync(extra, PEM);
    const bundle = trustedCaBundle(extra);
    // A machine with no system bundle has nothing to add the authority to.
    const hasSystem = [
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/ssl/cert.pem",
      "/etc/pki/tls/certs/ca-bundle.crt",
    ].some((p) => existsSync(p));
    if (!hasSystem) {
      expect(bundle).toBeUndefined();
      return;
    }
    expect(bundle).toBeDefined();
    const text = readFileSync(bundle!, "utf8");
    expect(text.endsWith(PEM)).toBe(true);
    expect(text.length).toBeGreaterThan(PEM.length + 100);
    expect(trustedCaBundle(extra)).toBe(bundle!);
  });

  test("an authority that does not exist on disk is not trusted", () => {
    expect(trustedCaBundle("/nowhere/at/all.crt")).toBeUndefined();
  });

  test("the git environment carries the bundle when there is one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-ca-"));
    const extra = join(dir, "ca.crt");
    writeFileSync(extra, PEM);
    const before = process.env["NODE_EXTRA_CA_CERTS"];
    process.env["NODE_EXTRA_CA_CERTS"] = extra;
    try {
      const env = gitEnv();
      const bundle = trustedCaBundle(extra);
      if (bundle === undefined) expect(env["GIT_SSL_CAINFO"]).toBeUndefined();
      else expect(env["GIT_SSL_CAINFO"]).toBe(bundle);
      expect(env["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
    } finally {
      if (before === undefined) delete process.env["NODE_EXTRA_CA_CERTS"];
      else process.env["NODE_EXTRA_CA_CERTS"] = before;
    }
  });
});
