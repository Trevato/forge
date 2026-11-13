/**
 * What was scraped and who did it: reads by repository and path with secrets
 * flagged, networks from the forge's own table, requests grouped across
 * addresses with a stated confidence, and a bounded capture that keeps no
 * secrets and expires (#9406).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { wasViaEdge, notePeer } from "../src/http/peer.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { groupRequests } from "../src/perf/actors.ts";
import { botScoreOf, CAPTURE_MAX, CAPTURE_MS, createCaptureStore } from "../src/perf/capture.ts";
import { captureStore } from "../src/perf/live.ts";
import { networkTable, parseNetworks, saveNetworks } from "../src/perf/network.ts";
import { createReadLedger, createReadWriter, HOUR_KEYS_MAX, OTHER_PATH, readOf, readsReport, secretPath } from "../src/perf/reads.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let admin: User;
let bob: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-scrapes-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const person = async (username: string, isAdmin = false): Promise<User> => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "correct-horse-battery", isAdmin });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  admin = await person("keeper", true);
  bob = await person("bob");
});
afterAll(async () => {
  captureStore.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const input = (path: string, address: string, headers: Record<string, string> = {}, cls: "deep" | "people" = "deep", pattern = "/:owner/:name/blob/:ref/*", viaEdge = true) => ({
  request: new Request(`http://forge.test${path}`, { headers: { "user-agent": "ScrapeBot/1.0", ...headers } }),
  address,
  viaEdge,
  status: 200,
  ms: 5,
  cls,
  pattern,
});

test("a file read names repository, ref and path; other routes read nothing", () => {
  expect(readOf("/:owner/:name/blob/:ref/*", "/alice/open/blob/main/src/a%20b.ts")).toEqual({ repo: "alice/open", ref: "main", path: "src/a b.ts" });
  expect(readOf("/:owner/:name/commit/:sha", "/alice/open/commit/abc1234")?.ref).toBe("abc1234");
  expect(readOf("/:owner/:name/issues", "/alice/open/issues")).toBeNull();
  expect(secretPath(".env")).toBe(true);
  expect(secretPath("deploy/id_rsa")).toBe(true);
  expect(secretPath("src/main.ts")).toBe(false);
});

test("reads are reported over a window of at most 7 days, secrets flagged, and no address kept", () => {
  const ledger = createReadLedger();
  ledger.note(NOW, { repo: "alice/open", ref: "abc1234", path: ".env" }, true);
  ledger.note(NOW, { repo: "alice/open", ref: "main", path: "src/a.ts" }, false);
  ledger.note(NOW - 2 * 24 * HOUR, { repo: "alice/open", ref: "main", path: "old.ts" }, true);
  const day = readsReport(app.db, ledger, NOW, 1);
  expect(day[0]?.requests).toBe(2);
  expect(day[0]?.secrets.map((s) => s.path)).toEqual([".env"]);
  expect(day[0]?.commits[0]?.ref).toBe("abc1234");
  expect(readsReport(app.db, ledger, NOW, 3)[0]?.requests).toBe(3);
  expect(readsReport(app.db, ledger, NOW, 99)[0]?.requests).toBe(3); // cut to 7 days
});

test("a network is found in the forge's own table, most specific first, and absence is absence", () => {
  const parsed = parseNetworks(
    "# comment\n203.0.0.0/8, Wide, Wide Inc, us, abuse@wide.example\n203.0.0.0/16, Narrow, Narrow Ltd, NL, https://narrow.example/abuse\nbad line\n10.0.0.0/8, X, X, USA, a@b.c\n1.2.0.0/16, Y, Y, DE, not a contact",
  );
  expect(parsed.rows).toHaveLength(2);
  expect(parsed.refused).toHaveLength(3);
  saveNetworks(app.db, parsed.rows, "keeper", NOW);
  const table = networkTable(app.db);
  expect(table.find("203.0.0.0/16")).toMatchObject({ name: "Narrow", country: "NL", scope: "whole" });
  expect(table.find("203.5.0.0/16")).toMatchObject({ name: "Wide", scope: "whole" });
  expect(table.find("198.51.0.0/16")).toBeNull();
  expect(table.find("203.0.113.9")?.abuse).toBe("https://narrow.example/abuse");
});

test("a capture is bounded, keeps no cookie, token or query, skips people, and expires by itself", () => {
  const store = createCaptureStore();
  expect(store.active(NOW)).toBe(false);
  store.start(NOW, "keeper");
  store.note(NOW, input("/alice/open/blob/main/a.ts?token=SECRET", "203.0.113.9", { cookie: "forge_session=SECRET", authorization: "Bearer SECRET", "cf-bot-score": "5" }));
  store.note(NOW, input("/alice/open", "198.51.100.1", {}, "people"));
  const c = store.current(NOW)!;
  expect(c.entries).toHaveLength(1);
  const json = JSON.stringify(c);
  expect(json).not.toContain("SECRET");
  expect(c.entries[0]).toMatchObject({ prefix: "203.0.0.0/16", botScore: 5, address: "203.0.113.9" });
  expect(c.entries[0]!.shape).not.toContain("cookie");
  for (let i = 0; i < CAPTURE_MAX + 5; i++) store.note(NOW, input("/x", "203.0.113.9"));
  expect(store.current(NOW)!.entries).toHaveLength(CAPTURE_MAX);
  expect(store.current(NOW)!.full).toBe(true);
  expect(store.current(NOW + CAPTURE_MS)).toBeNull(); // expired: addresses gone
  expect(store.active(NOW + CAPTURE_MS)).toBe(false);
  store.note(NOW + CAPTURE_MS, input("/x", "203.0.113.9"));
  expect(store.current(NOW + CAPTURE_MS + 1)).toBeNull();
  expect(botScoreOf(new Headers({ "cf-bot-score": "150" }))).toBeNull();
});

test("requests that look alike are one group across addresses, with reasons and a confidence; a lone address is not called an actor", () => {
  const store = createCaptureStore();
  store.start(NOW, "keeper");
  for (let i = 0; i < 24; i++)
    store.note(NOW + i * 1000, input(`/alice/open/commit/${(0xabc1230 + i).toString(16)}`, `203.0.113.${i % 4}`, { "cf-bot-score": "3", "accept-language": "xx" }, "deep", "/:owner/:name/commit/:sha"));
  store.note(NOW, { ...input("/", "198.51.100.7", { "user-agent": "Other" }) });
  const groups = groupRequests(store.current(NOW + 30_000)!.entries);
  expect(groups).toHaveLength(2);
  const big = groups[0]!;
  expect(big.size).toBe(24);
  expect(big.addresses).toHaveLength(4);
  expect(big.cadence).toBe("steady");
  expect(big.commits.length).toBeGreaterThanOrEqual(3);
  expect(big.confidence).toBe("high");
  expect(big.reasons.join(" ")).toContain("bot score");
  expect(groups[1]!.confidence).toBe("low");
  expect(groups[1]!.reasons.join(" ")).toContain("Only one address");
});

test("the page, capture, import and export are an admin's and need a same-origin post", async () => {
  const cookie = `forge_session=${createSession(app.db, admin.id).token}`;
  const other = `forge_session=${createSession(app.db, bob.id).token}`;
  const url = `${servers.url}/settings/traffic/scrapes`;
  expect((await fetch(url, { headers: { cookie: other } })).status).toBe(403);
  const page = await fetch(url, { headers: { cookie } });
  expect(page.status).toBe(200);
  const text = await page.text();
  expect(text).toContain("Start a capture");
  expect(text).toContain("What was read");

  const post = (path: string, body: string, origin = servers.url) =>
    fetch(`${url}/${path}`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body });
  expect((await post("capture", "", "https://evil.example")).status).toBe(403);
  expect(captureStore.active(Date.now())).toBe(false);
  expect((await post("capture", "")).status).toBe(303);
  expect(captureStore.active(Date.now())).toBe(true);
  expect((await post("networks", `lines=${encodeURIComponent("203.0.0.0/16, <b>Evil</b>, Op, DE, abuse@op.example")}`)).status).toBe(303);

  for (let i = 0; i < 12; i++) captureStore.note(Date.now(), input(`/alice/open/blob/main/f${i}.ts`, `203.0.113.${i}`));
  const shown = await (await fetch(url, { headers: { cookie } })).text();
  const id = /group=([0-9a-f]{8})/.exec(shown)?.[1];
  expect(id).toBeDefined();
  expect(shown).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  expect(shown).not.toContain("<b>Evil</b>");
  const detail = await (await fetch(`${url}?group=${id}`, { headers: { cookie } })).text();
  expect(detail).toContain("203.0.113.3");
  expect(detail).toContain("does not show who is behind");

  const report = await fetch(`${url}/export?group=${id}`, { headers: { cookie } });
  expect(report.headers.get("content-type")).toContain("text/plain");
  const reportText = await report.text();
  expect(reportText).toContain("abuse@op.example");
  expect(reportText).toContain("Limits:");
  expect((await fetch(`${url}/export?group=${id}`, { headers: { cookie: other } })).status).toBe(403);

  expect((await post("stop", "")).status).toBe(303);
  expect(captureStore.current(Date.now())).toBeNull();
  expect((await fetch(`${url}/export?group=${id}`, { headers: { cookie } })).status).toBe(404);
});

test("a stored hour holds at most HOUR_KEYS_MAX distinct reads however many minutes wrote it; the rest fold into (others)", () => {
  const ledger = createReadLedger();
  const writer = createReadWriter(app.db, ledger, { warn() {} }, () => NOW, 3_600_000);
  const hour = Math.floor((NOW + 5 * HOUR) / HOUR);
  const at = hour * HOUR;
  for (let minute = 0; minute < 4; minute++) {
    for (let i = 0; i < HOUR_KEYS_MAX; i++) ledger.note(at, { repo: "carol/wide", ref: "main", path: `m${minute}/f${i}.ts` }, true);
    writer.flush();
  }
  writer.stop();
  const n = app.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM read_hour WHERE hour = ?1").get(hour)!.n;
  expect(n).toBeLessThanOrEqual(HOUR_KEYS_MAX + 1);
  const folded = app.db.query<{ requests: number }, [number, string]>("SELECT requests FROM read_hour WHERE hour = ?1 AND path = ?2").get(hour, OTHER_PATH)!;
  expect(folded.requests).toBe(3 * HOUR_KEYS_MAX);
  // nothing is lost from the totals
  expect(readsReport(app.db, createReadLedger(), at, 1).find((r) => r.repo === "carol/wide")?.requests).toBe(4 * HOUR_KEYS_MAX);
});

test("a bot score and country are believed only from a trusted edge", () => {
  const store = createCaptureStore();
  store.start(NOW, "keeper");
  store.note(NOW, input("/x", "203.0.113.1", { "cf-bot-score": "5", "cf-ipcountry": "NL" }, "deep", "/:owner/:name/blob/:ref/*", false));
  store.note(NOW, input("/x", "203.0.113.2", { "cf-bot-score": "5", "cf-ipcountry": "NL" }));
  const [forged, edged] = store.current(NOW)!.entries;
  expect(forged).toMatchObject({ botScore: null, country: null });
  expect(edged).toMatchObject({ botScore: 5, country: "NL" });
  const viaProxy = new Request("http://forge.test/");
  notePeer(viaProxy, "127.0.0.1", { proxies: [] });
  const direct = new Request("http://forge.test/", { headers: { "cf-bot-score": "5" } });
  notePeer(direct, "198.51.100.9", { proxies: [] });
  expect(wasViaEdge(viaProxy) || wasViaEdge(direct)).toBe(false); // loopback with no client named is the forge itself; a stranger is no edge
  const named = new Request("http://forge.test/", { headers: { "cf-connecting-ip": "203.0.113.5" } });
  notePeer(named, "127.0.0.1", { proxies: [] });
  expect(wasViaEdge(named)).toBe(true);
});

test("an agent account, even an admin's, cannot start a capture or import networks", async () => {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "botty", email: "botty@forge.local", password: "correct-horse-battery", isAdmin: true });
  if (!made.ok) throw new Error(made.error);
  app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(made.value.id);
  const cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
  const url = `${servers.url}/settings/traffic/scrapes`;
  const post = (path: string, body = "") =>
    fetch(`${url}/${path}`, { method: "POST", redirect: "manual", headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" }, body });
  expect((await post("capture")).status).toBe(404);
  expect(captureStore.active(Date.now())).toBe(false);
  expect((await post("networks", "lines=" + encodeURIComponent("198.51.100.0/24, A, B, DE, a@b.example"))).status).toBe(404);
  expect(networkTable(app.db).find("198.51.100.5")).toBeNull();
});
