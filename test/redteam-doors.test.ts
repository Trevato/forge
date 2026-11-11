/**
 * The red-team findings of #10441 (docs/ops/RED-TEAM.md), each kept as a
 * test that fails the day its door reopens.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appEnv } from "../src/apps/process.ts";
import { IDENTITY_HEADERS, stripForgeCredentials } from "../src/apps/proxy.ts";
import { edgeIdentity } from "../src/http/edge.ts";

const FORGE_SECRETS = {
  FORGE_EDGE_TOKEN: "edge-secret-xyz",
  FORGE_SECRET_KEY: "secret-key-xyz",
  FORGE_TOKEN: "forge-own-token-xyz",
  ANTHROPIC_API_KEY: "sk-ant-xyz",
  GITHUB_TOKEN: "ghp-xyz",
  DATABASE_URL: "postgres://forge:pw@db/forge",
};

const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function envWithForgeSecretsSet(): Record<string, string> {
  for (const [name, value] of Object.entries(FORGE_SECRETS)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  return appEnv({
    port: 4100,
    dataDir: "/data/apps/notes/production",
    env: "production",
    url: "https://notes.example",
    commitOid: "a".repeat(40),
    forgeUrl: "https://forge.example",
    identityKey: "identity-key",
  });
}

describe("app to forge: an app process hears none of the forge's secrets", () => {
  test("no forge secret's value reaches the app's environment", () => {
    const env = envWithForgeSecretsSet();
    const values = Object.values(env).join("\n");
    for (const secret of Object.values(FORGE_SECRETS)) expect(values).not.toContain(secret);
    expect(env["FORGE_EDGE_TOKEN"]).toBeUndefined();
    expect(env["FORGE_TOKEN"]).toBeUndefined();
  });

  test("the app's environment is an allowlist, not the forge's environment minus some", () => {
    const env = envWithForgeSecretsSet();
    const allowed = new Set([
      "PATH", "HOME", "LANG", "TMPDIR", "PORT", "HOST", "NODE_ENV",
      "FORGE_APP_ENV", "FORGE_APP_DATA", "FORGE_APP_URL", "FORGE_APP_COMMIT",
      "FORGE_URL", "FORGE_API_URL", "FORGE_APP_IDENTITY_KEY",
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    ]);
    for (const name of Object.keys(env)) expect(allowed.has(name) ? name : `unexpected ${name}`).toBe(name);
  });

  test("its data directory is its own, never the forge's", () => {
    const env = envWithForgeSecretsSet();
    expect(env["FORGE_APP_DATA"]).toBe("/data/apps/notes/production");
  });
});

describe("forged identity headers: what a visitor writes never reaches an app as truth", () => {
  test("the forge's identity headers are the ones the proxy replaces", () => {
    expect(IDENTITY_HEADERS).toEqual(["x-forge-identity", "x-forge-signature"]);
  });

  test("edge headers, bearer tokens and the grant cookie are stripped before the app", () => {
    const headers = new Headers({
      "x-plat-user": "admin",
      "x-plat-edge-token": "edge-secret-xyz",
      "X-Plat-Anything": "1",
      authorization: "Bearer forge-own-token-xyz",
      cookie: "forge_grant_notes=abc; theme=dark",
    });
    stripForgeCredentials(headers, "forge_grant_notes");
    expect([...headers.keys()].filter((n) => n.startsWith("x-plat-"))).toEqual([]);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBe("theme=dark");
  });

  test("an edge claim without the edge's secret is nobody", () => {
    const forged = new Request("https://forge.example/", { headers: { "x-plat-user": "trevato" } });
    expect(edgeIdentity(forged, "edge-secret-xyz")).toBeUndefined();
    const wrong = new Request("https://forge.example/", {
      headers: { "x-plat-user": "trevato", "x-plat-edge-token": "guess" },
    });
    expect(edgeIdentity(wrong, "edge-secret-xyz")).toBeUndefined();
    expect(edgeIdentity(wrong, "")).toBeUndefined();
    expect(edgeIdentity(wrong, undefined)).toBeUndefined();
  });
});
