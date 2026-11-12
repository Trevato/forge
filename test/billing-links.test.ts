/**
 * The bridge to paid hosting (#11149): `billing.links` is empty by default and
 * the anonymous home shows the plans with no pay link; with links set, each
 * paid plan whose size has a link carries a plain "Get <plan>" link to it,
 * beside the home's one "Get a forge" button (#11139).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getBillingLinks, parseBillingLinks, sizeWords } from "../src/settings/billing.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { promote } from "./helpers/members.ts";
import { adminOpenapi } from "./helpers/openapi-doc.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let adminToken: string;
let memberToken: string;
let adminCookie: string;
let memberCookie: string;

const LINKS = {
  small: "https://buy.stripe.com/small-test",
  medium: "https://buy.stripe.com/medium-test",
  large: "https://buy.stripe.com/large-test",
};

const home = async (): Promise<string> => (await fetch(`${servers.url}/`)).text();
const guide = async (): Promise<string> => (await fetch(`${servers.url}/llms.txt`)).text();
const patch = (token: string, body: unknown) =>
  fetch(`${servers.url}/api/v1/admin/settings`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-billing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = async (username: string) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      allowReserved: true,
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const admin = await make("owner");
  const member = await make("mia");
  adminToken = createToken(app.db, admin.id, "admin", "admin").token;
  memberToken = createToken(app.db, member.id, "member", "rw").token;
  adminCookie = `forge_session=${createSession(app.db, admin.id).token}`;
  memberCookie = `forge_session=${createSession(app.db, member.id).token}`;
});
afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("no links by default: the home shows the plans, one button and no pay link", async () => {
  expect(getBillingLinks(app.db)).toEqual({});
  const text = await home();
  expect(text).not.toContain("Hosted forges are");
  expect(text).not.toContain("Pay for");
  expect(text.match(/>Get a forge</g)).toHaveLength(1);
  expect(await guide()).not.toContain("while hosting is not sold");
});

test("only http(s) addresses without credentials, only the three sizes", () => {
  for (const bad of [
    { small: "http://x.test/" },
    { small: "javascript:alert(1)" },
    { small: "https://u:p@x.test/" },
    { small: 5 },
    { small: 'https://x.test/"onclick="y' },
    { huge: "https://x.test/" },
    [],
    "https://x.test/",
  ])
    expect(parseBillingLinks(bad).ok).toBe(false);
  expect(parseBillingLinks({ small: "", medium: null })).toEqual({ ok: true, value: {} });
});

test("a plain member cannot set the links", async () => {
  expect((await patch(memberToken, { billingLinks: LINKS })).status).toBe(403);
  expect(getBillingLinks(app.db)).toEqual({});
});

test("a bad link is refused and nothing is kept", async () => {
  const res = await patch(adminToken, { billingLinks: { small: "http://insecure.test" } });
  expect(res.status).toBe(422);
  expect(getBillingLinks(app.db)).toEqual({});
});

const yours = (text: string): string => text.slice(text.indexOf('id="yours"'), text.indexOf('class="door-org"'));
const payAnchors = (section: string): string[] => [...section.matchAll(/<a\s[^>]*href="https:[^>]*>Get [^<]*<\/a\s*>/g)].map((m) => m[0]);

test("with three links each paid plan carries a pay link; the button stays one", async () => {
  const res = await patch(adminToken, { billingLinks: LINKS });
  expect(res.status).toBe(200);
  const read = (await (await fetch(`${servers.url}/api/v1/admin/settings`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as { billingLinks: unknown };
  expect(read.billingLinks).toEqual(LINKS);
  const section = yours(await home());
  const anchors = payAnchors(section);
  expect(anchors).toHaveLength(3);
  for (const [i, size] of (["small", "medium", "large"] as const).entries()) {
    expect(anchors[i]).toContain(`href="${LINKS[size]}"`);
    expect(anchors[i]).toContain("noopener");
    expect(section).toContain(sizeWords(size));
  }
  expect(section.match(/>Get a forge</g)).toHaveLength(1);
  expect(section).not.toContain("Pay for");
});

test("a size without a link has no pay link; clearing every link restores the page", async () => {
  await patch(adminToken, { billingLinks: { medium: LINKS.medium } });
  const one = payAnchors(yours(await home()));
  expect(one).toHaveLength(1);
  expect(one[0]).toContain(LINKS.medium);
  await patch(adminToken, { billingLinks: {} });
  // three real changes so far (set, narrowed, cleared); the refused ones kept nothing
  const kept = app.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM forge_setting_change WHERE key = 'billing.links'")
    .get();
  expect(kept?.n).toBe(3);
  expect(payAnchors(yours(await home()))).toHaveLength(0);
});

const form = (cookie: string, fields: Record<string, string>, origin: string = servers.url) =>
  fetch(`${servers.url}/admin/billing-links`, {
    method: "POST",
    headers: { cookie, origin, accept: "text/html" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
const flashed = (res: Response): string => decodeURIComponent((res.headers.get("set-cookie") ?? "").replace(/\+/g, " "));

test("the form: a member is refused, a cross-origin post is refused, nothing is kept", async () => {
  expect([403, 404]).toContain((await form(memberCookie, { small: LINKS.small })).status);
  expect((await form(adminCookie, { small: LINKS.small }, "https://elsewhere.test")).status).toBe(403);
  expect(getBillingLinks(app.db)).toEqual({});
});

test("the form: a bad address flashes danger and keeps nothing; a good one is saved", async () => {
  const bad = await form(adminCookie, { small: "http://insecure.test" });
  expect(bad.status).toBe(303);
  expect(flashed(bad)).toContain("https address");
  expect(getBillingLinks(app.db)).toEqual({});
  const good = await form(adminCookie, { small: LINKS.small, medium: "", large: LINKS.large });
  expect(good.status).toBe(303);
  expect(flashed(good)).toContain("Buy links saved.");
  expect(getBillingLinks(app.db)).toEqual({ small: LINKS.small, large: LINKS.large });
  await patch(adminToken, { billingLinks: {} });
});

const tool = async (token: string, args: unknown) => mcpTool(servers.url, token, "signup", args);

test("MCP signup: billingLinks plans first, needs an admin token to apply, and a read returns them", async () => {
  const dry = await tool(adminToken, { billingLinks: LINKS });
  expect(dry.value.says).toContain("Would set");
  expect(getBillingLinks(app.db)).toEqual({});
  const rw = createToken(app.db, (app.db.query("SELECT id FROM user WHERE username = 'owner'").get() as { id: string }).id, "rw", "rw").token;
  expect((await tool(rw, { billingLinks: LINKS, dryRun: false })).error).toBeDefined();
  expect(getBillingLinks(app.db)).toEqual({});
  expect((await tool(adminToken, { billingLinks: { small: "http://x.test" }, dryRun: false })).error).toBeDefined();
  const set = await tool(adminToken, { billingLinks: LINKS, dryRun: false });
  expect(set.value.billingLinks).toEqual(LINKS);
  expect((await tool(adminToken, {})).value.billingLinks).toEqual(LINKS);
  await patch(adminToken, { billingLinks: {} });
});

const links = (cookie: string, fields: Record<string, string>) =>
  fetch(`${servers.url}/settings/billing/links`, {
    method: "POST",
    headers: { cookie, origin: servers.url, accept: "text/html" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

test("Settings → Billing: set three links, the home shows them; clear, the home is as before", async () => {
  const page = await (await fetch(`${servers.url}/settings/billing`, { headers: { cookie: adminCookie } })).text();
  expect(page).toContain("Payment links");
  for (const z of ["small", "medium", "large"]) expect(page).toContain(`name="${z}"`);
  expect((await links(memberCookie, LINKS)).status).toBe(404);
  const bad = await links(adminCookie, { ...LINKS, large: "http://nope.test" });
  expect(bad.status).toBe(422);
  const badPage = await bad.text();
  expect(badPage).toContain("large: each payment link is an https address");
  expect(badPage).not.toContain("small and");
  // What was typed stays in the form.
  expect(badPage).toContain('value="http://nope.test"');
  expect(badPage).toContain(`value="${LINKS.small}"`);
  expect(getBillingLinks(app.db)).toEqual({});
  expect((await links(adminCookie, LINKS)).status).toBe(303);
  // Since #11164 the home has one "Get a forge" button and a pay link per paid plan.
  const section = yours(await home());
  expect(section.match(/>Get a forge</g)).toHaveLength(1);
  const anchors = payAnchors(section);
  expect(anchors).toHaveLength(3);
  for (const u of Object.values(LINKS)) expect(section).toContain(`href="${u}"`);
  await links(adminCookie, { small: "", medium: "", large: "" });
  expect(getBillingLinks(app.db)).toEqual({});
  const none = yours(await home());
  expect(payAnchors(none)).toHaveLength(0);
  for (const u of Object.values(LINKS)) expect(none).not.toContain(u);
  expect(none.match(/>Get a forge</g)).toHaveLength(1);
});

test("PUT /api/v1/admin/billing/links replaces the links; a member and a bad link are refused; the spec names it", async () => {
  const put = (token: string, links: unknown) =>
    fetch(`${servers.url}/api/v1/admin/billing/links`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ links }),
    });
  expect((await put(memberToken, LINKS)).status).toBe(403);
  expect((await put(adminToken, { small: "http://x.test" })).status).toBe(422);
  const ok = await put(adminToken, LINKS);
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { links: unknown }).links).toEqual(LINKS);
  expect(getBillingLinks(app.db)).toEqual(LINKS);
  await put(adminToken, {});
  expect(getBillingLinks(app.db)).toEqual({});
  const spec = await (await adminOpenapi(app, servers.url, "/api/v1/openapi.json")).text();
  expect(spec).toContain("/api/v1/admin/billing/links");
});
