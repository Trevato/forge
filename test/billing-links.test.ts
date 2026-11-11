/**
 * The bridge to paid hosting (#11149): `billing.links` is empty by default and
 * the anonymous home reads as it did; with links set, `#yours` shows one row
 * a plan, each button opening its link, and "coming" and "not sold" are gone.
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

test("no links by default: the home says hosted forges are coming and shows no plan", async () => {
  expect(getBillingLinks(app.db)).toEqual({});
  const text = await home();
  expect(text).toContain("Hosted forges are");
  expect(text).not.toContain("Get a forge");
  expect(await guide()).toContain("while hosting is not sold");
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

test("with three links the home shows three rows, each a button to its link", async () => {
  const res = await patch(adminToken, { billingLinks: LINKS });
  expect(res.status).toBe(200);
  const read = (await (await fetch(`${servers.url}/api/v1/admin/settings`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as { billingLinks: unknown };
  expect(read.billingLinks).toEqual(LINKS);
  const text = await home();
  const section = text.slice(text.indexOf('id="plans"'), text.indexOf("Read the step-by-step guide"));
  const anchors = [...section.matchAll(/<a\s[^>]*>Get a forge<\/a\s*>/g)].map((m) => m[0]);
  expect(anchors).toHaveLength(3);
  for (const [i, size] of (["small", "medium", "large"] as const).entries()) {
    expect(anchors[i]).toContain(`href="${LINKS[size]}"`);
    expect(anchors[i]).toContain("noopener");
    expect(section).toContain(sizeWords(size));
  }
  expect(section).toContain("$19 a month, with $5 of crew credit");
  expect(section).toContain("$49 a month, with $15 of crew credit");
  expect(section).toContain("$149 a month, with $50 of crew credit");
  expect(section).toContain("Your forge is made after payment; the link to claim it arrives by email, usually within a few hours.");
  expect(text).not.toContain("Hosted forges are");
  expect(await guide()).not.toContain("while hosting is not sold");
});

test("a size without a link has no row; clearing every link restores the page", async () => {
  await patch(adminToken, { billingLinks: { medium: LINKS.medium } });
  const one = await home();
  expect(one.match(/Get a forge/g)).toHaveLength(1);
  expect(one).toContain("$49 a month");
  expect(one).not.toContain("$19 a month");
  await patch(adminToken, { billingLinks: {} });
  // three real changes so far (set, narrowed, cleared); the refused ones kept nothing
  const kept = app.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM forge_setting_change WHERE key = 'billing.links'")
    .get();
  expect(kept?.n).toBe(3);
  const none = await home();
  expect(none).toContain("Hosted forges are");
  expect(none).not.toContain("Get a forge");
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
