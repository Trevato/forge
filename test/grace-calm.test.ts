/**
 * Grace is one line where it belongs (#11394): the forge's own /settings Plan
 * line says "Payment due — paused on <day> · Pay", the operator's /forges row
 * says "grace until <date>", and the home and the board carry no notice.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { keepNotice, noticeOf, tellPlan } from "../src/billing/notice.ts";
import { putEntitlement } from "../src/billing/store.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { clientRows, graceWords, type ClientRow } from "../src/spawn/clients.ts";
import { forgeLines } from "../src/tui/screens/forges.ts";
import { planLine } from "../src/web/plan_row.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const ELEMENT = /<[a-z][^<>]*?(?:\brole="alert"|\bclass="[^"]*\b(?:banner|notice|notice-danger|notice-warn|alert)\b[^"]*")[^<>]*>/gi;
const allowed = (tag: string): boolean => /\bclass="[^"]*\btoast\b/.test(tag) && (/\brole="status"/.test(tag) || /\bdata-tone="danger"/.test(tag));
const standing = (body: string): string[] => [...body.matchAll(ELEMENT)].map((m) => m[0]).filter((t) => !allowed(t));

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";
const PORTAL = "https://billing.stripe.com/p/login/grace";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-grace-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
  // This forge is itself told it is in grace (its own plan.json), and as a host it holds a child in grace.
  await writeFile(join(dir, "parent.json"), JSON.stringify({ upstream: "https://host.example" }));
  keepNotice(dir, { name: "Medium", size: "medium", priceUsd: 49, creditUsd: 10, status: "grace", periodEnd: Date.UTC(2026, 10, 18) / 1000, portalUrl: PORTAL });
  await mkdir(join(dir, "spawn"), { recursive: true });
  await writeFile(join(dir, "spawn", "alpha.json"), JSON.stringify({ name: "alpha", bodyId: "body-alpha", done: true, size: "small", org: "alpha", apps: [] }));
  await mkdir(childDirOf(app, "body-alpha"), { recursive: true });
  await writeFile(join(childDirOf(app, "body-alpha"), "parent.json"), JSON.stringify({ upstream: "https://host.example" }));
  putEntitlement(app.db, { forge: "alpha", plan: "medium", status: "grace", periodEnd: 1_796_000_000, provider: "stripe", customerId: "cus_x", subscriptionId: "sub_x", source: "stripe" }, "small", "");
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "follow" });
  expect(res.status).toBe(200);
  return res.text();
};

test("the plan line says when it pauses, and settings carries it with a Pay link", async () => {
  expect(planLine(dir)).toContain("Payment due — paused on 18 Nov");
  const body = await get("/settings");
  expect(body).toContain("Payment due — paused on 18 Nov");
  expect(body).toMatch(new RegExp(`· <a href="${PORTAL}"[^>]*>Pay</a>`));
});

test("a told forge learns the day grace ends, not the provider's period end", () => {
  expect(tellPlan(app, "alpha")).toBe(true);
  const told = noticeOf(childDirOf(app, "body-alpha"))!;
  expect(told.status).toBe("grace");
  expect(told.periodEnd).toBeGreaterThan(Date.now() / 1000);
  expect(told.periodEnd).not.toBe(1_796_000_000);
});

test("the operator's /forges row says grace until the date", async () => {
  const body = await get("/forges");
  expect(body).toMatch(/<span data-grace>grace until \d{4}-\d{2}-\d{2}<\/span>/);
  expect(graceWords({})).toBeNull();
  expect(graceWords({ graceUntil: Date.UTC(2026, 10, 18) })).toBe("grace until 2026-11-18");
});

test("in grace, the home and the board carry no notice and none of the words", async () => {
  for (const path of ["/", "/board"]) {
    const body = await get(path);
    expect({ path, found: standing(body) }).toEqual({ path, found: [] });
    expect(body).not.toContain("Payment due");
    expect(body).not.toContain("grace until");
  }
});

test("the terminal's forges screen says grace until the date for a forge in grace, and only then", async () => {
  const rows = await clientRows(app);
  const alpha = rows.find((r) => r.graceUntil !== undefined);
  expect(alpha).toBeDefined();
  const lines = forgeLines([alpha!]).map((l) => l[1]).join("\n");
  expect(lines).toContain(`grace until ${new Date(alpha!.graceUntil!).toISOString().slice(0, 10)}`);
  expect(forgeLines([{ ...alpha!, graceUntil: undefined } as unknown as ClientRow]).map((l) => l[1]).join("\n")).not.toContain("grace until");
});
