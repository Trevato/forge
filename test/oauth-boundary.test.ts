/**
 * The MCP OAuth boundary, called directly: `parseRegistration` refuses every
 * bad redirect, and `parseAuthRequest` accepts only an exact registered one
 * with an S256 challenge.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  createClient,
  parseAuthRequest,
  parseRegistration,
  type OAuthClient,
} from "../src/core/oauth.ts";

const reg = (redirect_uris: unknown) =>
  parseRegistration({ client_name: "Tool", redirect_uris });

describe("parseRegistration redirects", () => {
  test("refuses a missing, empty or non-array redirect_uris", () => {
    expect(parseRegistration({ client_name: "Tool" }).ok).toBe(false);
    expect(reg([]).ok).toBe(false);
    expect(reg("https://a.example/cb").ok).toBe(false);
    expect(reg({ 0: "https://a.example/cb" }).ok).toBe(false);
  });

  test("refuses a non-string entry, relative, fragment, javascript:", () => {
    for (const bad of [
      [42],
      [null],
      ["/callback"],
      ["callback"],
      ["https://a.example/cb#frag"],
      ["javascript:alert(1)"],
      ["https://a.example/cb", "javascript:alert(1)"],
    ]) {
      const r = reg(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.error).toBe("invalid_redirect_uri");
    }
  });

  test("refuses remote http", () => {
    expect(reg(["http://a.example/cb"]).ok).toBe(false);
  });

  test("accepts https and the loopback forms", () => {
    for (const good of [
      "https://a.example/cb",
      "http://localhost:8080/cb",
      "http://127.0.0.1:3000/cb",
      "http://[::1]:3000/cb",
    ])
      expect(reg([good]).ok).toBe(true);
  });
});

describe("parseAuthRequest", () => {
  let dataDir: string;
  let app: App;
  let client: OAuthClient;
  const REDIRECT = "https://a.example/Callback";
  const CHALLENGE = "A".repeat(43);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-boundary-"));
    app = createApp({ dataDir, port: 0 });
    client = createClient(app.db, {
      name: "Tool",
      redirectUris: [REDIRECT],
    });
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const parse = (over: Record<string, string> = {}) => {
    const params: Record<string, string> = {
      client_id: client.id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      ...over,
    };
    return parseAuthRequest(app.db, (name) => params[name] ?? "");
  };

  test("accepts an exact match", () => {
    const r = parse();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.redirectUri).toBe(REDIRECT);
  });

  test("refuses an unknown client", () => {
    expect(parse({ client_id: "nope" }).ok).toBe(false);
  });

  test("refuses a prefix, a case change or a trailing slash", () => {
    for (const uri of [
      "https://a.example/Call",
      "https://a.example/callback",
      "https://a.example/Callback/",
      "https://a.example/Callback?x=1",
      "https://a.example",
      "",
    ])
      expect(parse({ redirect_uri: uri }).ok).toBe(false);
  });

  test("refuses a missing challenge and any method but S256", () => {
    expect(parse({ code_challenge: "" }).ok).toBe(false);
    expect(parse({ code_challenge_method: "plain" }).ok).toBe(false);
    expect(parse({ code_challenge_method: "s256" }).ok).toBe(false);
    expect(parse({ code_challenge_method: "" }).ok).toBe(false);
  });
});
