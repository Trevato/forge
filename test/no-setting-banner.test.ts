/**
 * The owner's rule (#10825): a setting is one line where it belongs, never a
 * banner over the board. Every first paint an owner lands on is read with the
 * forge's settings in their unusual states (egress reported, every limit at
 * its floor, a flag declared and set); nothing that draws as an alert may sit
 * above the page's content. There is no allowlist: a healthy forge draws no
 * red above its content, and a real failure is not a setting.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { makeFlags } from "../src/core/flags.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { LIMITS, setLimit, type LimitKey } from "../src/settings/limits.ts";
import { EGRESS_REPORTED } from "../src/system/egress_line.ts";
import { useFlagRegistry } from "../src/web/pages/flags.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const REASON = "test: an unusual setting";

/** Any element that draws as an alert or a danger notice. */
const ALERT = /<(?!script|style|svg|path)[a-z0-9]+\b[^>]*(?:role="alert"|data-tone="danger"|class="[^"]*\b(?:danger|toast|error)\b[^"]*")[^>]*>/g;

/** What sits above a page's content: the markup before `<main`, and main's own top up to the page's first heading. */
function aboveContent(html: string): string {
  const main = html.indexOf("<main");
  // The content starts at the page's heading, or at the board's grid (the board has no heading).
  const starts = main < 0 ? [] : ["<h1", "board-grid"].map((m) => html.indexOf(m, main)).filter((i) => i >= 0);
  return html.slice(0, starts.length === 0 ? main : Math.min(...starts));
}

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-no-setting-banner-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const made = await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  // Every limit at its floor: the tightest state a limit can be in.
  for (const key of Object.keys(LIMITS) as LimitKey[]) {
    const r = setLimit(app.db, key, LIMITS[key].min, made.value.id);
    if (!r.ok) throw new Error(`${key}: ${r.error.message}`);
  }
  const set = changeCapacity(app, made.value, "cells.egress", "report", REASON);
  if (!set.ok) throw new Error(set.error);
  // A flag, declared and set.
  const flags = makeFlags({ probe: { why: "a flag the scan sets", default: false, issue: 10825 } });
  expect(flags.set(app.db, "probe", { forge: true }, made.value.id)).toBe(true);
  useFlagRegistry(flags);
  servers = await serve(app);
});
afterAll(() => {
  useFlagRegistry(undefined);
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const read = async (path: string): Promise<string> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(200);
  return res.text();
};

for (const path of ["/", "/board", "/system", "/apps"]) {
  test(`${path} draws no alert above its content because of a setting`, async () => {
    const html = await read(path);
    expect(html).toContain("<main");
    // The scan must reach real content: it ends after `<main`, not at it.
    expect(aboveContent(html).length).toBeGreaterThan(html.indexOf("<main"));
    expect(aboveContent(html).match(ALERT) ?? []).toEqual([]);
  });
}

test("the settings are in their states, and each says so on its own page with its reason", async () => {
  const system = await read("/system");
  expect(system).toContain(EGRESS_REPORTED);
  const capacity = await read("/settings/capacity");
  expect(capacity).toContain(REASON);
  const limits = await read("/admin/limits");
  expect(limits).toContain(String(LIMITS["crew.concurrency"].min));
  const flags = await read("/settings/flags");
  expect(flags).toContain("a flag the scan sets");
});

test("the detector sees a banner above the content and ignores an error below it", () => {
  const page = (top: string, low: string) =>
    `<header>${top}</header><main id="main"><h1>Board</h1>${low}</main>`;
  const banner = '<div class="toast" data-tone="danger" role="alert">Egress is reported</div>';
  expect(aboveContent(page(banner, "")).match(ALERT)?.length).toBe(1);
  expect(aboveContent(page("", banner.replace("<div", "<div id=\"x\""))).match(ALERT) ?? []).toEqual([]);
  expect(aboveContent(`<main id="main">${banner}<h1>Board</h1></main>`).match(ALERT)?.length).toBe(1);
});
