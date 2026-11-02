/**
 * Settings › Tokens names the harness behind each token the OAuth endpoint
 * minted (#8432): its client's registered name, escaped, and that it renews
 * itself; `GET /api/v1/tokens` and MCP `tokens` carry the same name as
 * `oauthClient`, and the terminal's sign-ins screen names it on the row. A hand-made token looks as it always did.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createClient, issueCode, listTokensWithClients, oauthClientNames, parseAuthRequest, redeemCode } from "../src/core/oauth.ts";
import { createToken, listTokens } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { signInsOf } from "../src/tui/screens/signins.ts";
import { Session } from "../src/tui/session.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(60);
const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
const RENEWS = "Signed in through OAuth; renews itself until you delete it";

let root = "";
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-tokens-oauth-client-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  proveAll(app);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function exchange(clientName: string, tokenName: string): Promise<void> {
  const client = createClient(app.db, { name: clientName, redirectUris: [REDIRECT] });
  const params: Record<string, string> = {
    client_id: client.id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: "rw",
  };
  const request = parseAuthRequest(app.db, (n) => params[n] ?? "");
  if (!request.ok) throw new Error(request.error);
  const code = issueCode(app.db, alice.id, request.value, { scope: "rw", name: tokenName, lifetimeS: null });
  const minted = await redeemCode(app.db, root, {
    code,
    clientId: client.id,
    redirectUri: REDIRECT,
    verifier,
    issuer: servers.url,
  });
  if (!minted.ok || minted.value.token === undefined) throw new Error("no token");
}

/** The table row that carries a token's name. */
function rowOf(page: string, tokenName: string): string {
  const row = page.split("<tr>").find((r) => r.includes(`<strong>${tokenName}</strong>`));
  if (row === undefined) throw new Error(`no row for ${tokenName}`);
  return row;
}

test("a token from the code exchange names its client; a hand-made one does not", async () => {
  await exchange("Claude Code", "harness-token");
  const made = createToken(app.db, alice.id, "laptop", "rw");
  expect(made.id).toBeTruthy();

  const page = await (await fetch(`${servers.url}/settings/tokens`, { headers: { cookie } })).text();
  const oauthRow = rowOf(page, "harness-token");
  expect(oauthRow).toContain("Claude Code");
  expect(oauthRow).toContain(RENEWS);
  const handRow = rowOf(page, "laptop");
  expect(handRow).not.toContain("data-oauth-client");
  expect(handRow).not.toContain(RENEWS);
});

test("a client name with <script> is escaped", async () => {
  await exchange("<script>alert(1)</script>", "evil-token");
  const page = await (await fetch(`${servers.url}/settings/tokens`, { headers: { cookie } })).text();
  const row = rowOf(page, "evil-token");
  expect(row).not.toContain("<script>alert(1)</script>");
  expect(row).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("the names come from one read covering only the person's own OAuth tokens", () => {
  const names = oauthClientNames(app.db, alice.id);
  const byName = new Map(listTokens(app.db, alice.id).map((t) => [t.name, t.id]));
  expect(names.get(byName.get("harness-token")!)).toBe("Claude Code");
  expect(names.has(byName.get("laptop")!)).toBe(false);
  expect(oauthClientNames(app.db, "nobody").size).toBe(0);
});

const harnessOf = (items: { name: string; oauthClient: string | null }[]) =>
  Object.fromEntries(items.map((t) => [t.name, t.oauthClient]));

test("GET /api/v1/tokens carries oauthClient on each token, null for a hand-made one", async () => {
  const res = await fetch(`${servers.url}/api/v1/tokens`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const listed = harnessOf((await res.json()) as { name: string; oauthClient: string | null }[]);
  expect(listed["harness-token"]).toBe("Claude Code");
  expect(listed["laptop"]).toBeNull();
});

test("MCP `tokens` carries oauthClient on each token, null for a hand-made one", async () => {
  const bearer = createToken(app.db, alice.id, "mcp-caller", "rw").token;
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tokens", arguments: {} } }),
  });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const listed = harnessOf(JSON.parse(body.result.content[0]!.text).items);
  expect(listed["harness-token"]).toBe("Claude Code");
  expect(listed["mcp-caller"]).toBeNull();
  expect(listTokensWithClients(app.db, alice.id).length).toBe(Object.keys(listed).length);
});

test("the terminal's sign-ins screen names the harness on an OAuth token's row", () => {
  const rows = signInsOf(new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice }));
  const where = (name: string) => rows.find((r) => r.kind === "token" && r.where.startsWith(`${name} · `))?.where;
  expect(where("harness-token")).toBe("harness-token · rw · Claude Code, renews itself");
  expect(where("laptop")).toBe("laptop · rw");
});
