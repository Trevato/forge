/**
 * A healthy forge's home and board carry no alert banner (#10699), and a real
 * fault (egress in report mode) is one line on its own settings page and on
 * System, never over `/` or `/board`. The design-lint `banner` rule holds the
 * source; this holds what is rendered.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { egressLines } from "../src/tui/screens/system.ts";
import type { Session } from "../src/tui/session.ts";
import { EGRESS_REPORTED } from "../src/system/egress_line.ts";
import { banner } from "../scripts/design-lint.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "", admin: Awaited<ReturnType<typeof seedAdmin>> & { ok: true };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-calm-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!made.ok) throw new Error(made.error);
  admin = made as typeof admin;
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  return res.text();
};
const alarming = (body: string) => /role="alert"/.test(body) || /class="[^"]*\b(?:banner|notice-danger)\b/.test(body);

test("a healthy forge's home and board have no alert, banner or danger notice", async () => {
  for (const path of ["/", "/board"]) {
    const body = await get(path);
    expect(body.length).toBeGreaterThan(500);
    expect(alarming(body)).toBe(false);
  }
});

test("with egress enforced, System and Capacity say nothing about it, and neither does the terminal", async () => {
  expect(await get("/system")).not.toContain("egress-reported");
  expect(await get("/settings/capacity")).not.toContain("egress-reported");
  expect(egressLines({ db: app.db } as Session)).toEqual([]);
});

test("egress in report mode is one line on Capacity and System, not on / or /board", async () => {
  const changed = await changeCapacity(app, admin.value, "cells.egress", "report", "a test says why");
  expect(changed.ok).toBe(true);
  expect(await get("/settings/capacity")).toContain('id="egress-reported"');
  expect(await get("/system")).toContain('id="egress-reported"');
  expect(egressLines({ db: app.db } as Session)).toEqual([EGRESS_REPORTED]);
  for (const path of ["/", "/board"]) {
    const body = await get(path);
    expect(body).not.toContain("egress-reported");
    expect(body.toLowerCase()).not.toContain("egress is reported");
    expect(alarming(body)).toBe(false);
  }
});

test("the banner rule names a standing alert and lets a transient flash through", () => {
  expect(banner('<div role="alert">x</div>')).toHaveLength(1);
  expect(banner('<p class="notice-danger">x</p>')).toHaveLength(1);
  expect(banner('<div class="stack banner">x</div>')).toHaveLength(1);
  expect(banner('<div role="alert" data-flash>x</div>')).toHaveLength(0);
  expect(banner('<p class="small">fine</p>')).toHaveLength(0);
});
