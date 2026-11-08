/**
 * The token forms accept the callers POST /api/v1/tokens accepts: a person
 * the platform edge signed in may mint from /settings/tokens (and a
 * repository's proposal tokens) on the forge's own origin. A cross-site
 * page riding the edge, and another token, are still refused.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createUser, type User } from "../src/core/users.ts";
import { listTokens } from "../src/core/tokens.ts";
import { markVerified } from "../src/core/verify.ts";
import { setMember } from "../src/core/roles.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const EDGE = "edge-secret-tokens-0123456789";
const ORIGIN = "https://forge.example";

describe("token forms behind the platform edge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let ada: User;
  const asAda = { "x-plat-user": "ada", "x-plat-edge-token": EDGE };

  const post = (path: string, fields: Record<string, string>, headers: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-web-tokens-edge-"));
    app = createApp({ dataDir, port: 0, url: ORIGIN, edgeToken: EDGE });
    servers = await serve(app);
    base = servers.url;
    const made = await createUser(app.db, { origin: "edge", username: "ada", email: "ada@forge.example" });
    if (!made.ok) throw new Error(made.error);
    ada = made.value;
    // Making a repository asks for a proven email and membership; each has
    // its own suite.
    markVerified(app.db, ada.id, new Date().toISOString());
    setMember(app.db, ada.id, true, ada.id, new Date());
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an edge sign-in mints a token from the settings form, as the API lets it", async () => {
    const before = listTokens(app.db, ada.id).length;
    const res = await post("/settings/tokens", { name: "laptop", scope: "rw" }, { ...asAda, origin: ORIGIN });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/tokens");
    const after = listTokens(app.db, ada.id);
    expect(after.length).toBe(before + 1);
    expect(after.some((t) => t.name === "laptop")).toBe(true);
  });

  test("a cross-site page cannot ride the edge to mint one", async () => {
    const before = listTokens(app.db, ada.id).length;
    const res = await post("/settings/tokens", { name: "evil", scope: "rw" }, { ...asAda, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(listTokens(app.db, ada.id).length).toBe(before);
  });

  test("a token still cannot mint another token through the form", async () => {
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { ...asAda, origin: ORIGIN },
      body: JSON.stringify({ name: "cli", scope: "rw" }),
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const before = listTokens(app.db, ada.id).length;
    const res = await post("/settings/tokens", { name: "bootstrap", scope: "rw" }, { authorization: `Bearer ${token}`, origin: ORIGIN });
    expect(res.status).toBe(403);
    expect(listTokens(app.db, ada.id).length).toBe(before);
  });

  test("an edge sign-in mints a proposal token from its repository's settings", async () => {
    const repo = await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: { ...asAda, origin: ORIGIN },
      body: JSON.stringify({ name: "lib", visibility: "public" }),
    });
    expect(repo.status).toBe(201);
    const fields = { child: "kid", origin: "https://kid.example.com/" };
    const res = await post("/ada/lib/settings/proposal-tokens", fields, { ...asAda, origin: ORIGIN });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ada/lib/settings");
    const csrf = await post("/ada/lib/settings/proposal-tokens", fields, { ...asAda, origin: "https://evil.example" });
    expect(csrf.status).toBe(403);
  });
});
