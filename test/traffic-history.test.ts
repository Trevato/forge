/**
 * Traffic outlives the process (`perf/traffic_store.ts`), the forge asking
 * itself is told apart, and a deleted repository is named only to those who
 * answer for it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRepo, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { createApp, type App } from "../src/app.ts";
import { actingVia } from "../src/core/acting_via.ts";
import { audienceFilter, eventForReader } from "../src/core/event_audience.ts";
import { listEvents, type ForgeEvent } from "../src/core/events.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { isInternalPeer } from "../src/http/peer.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  classOf,
  countryOf,
  createTrafficLedger,
  signatureOf,
  type TrafficClass,
} from "../src/perf/traffic.ts";
import { perfRecord } from "../src/perf/live.ts";
import { createTrafficWriter, HOUR_TOPS, trafficHistory, windowOf } from "../src/perf/traffic_store.ts";

const quiet = { warn: () => {} };
const MIN = 60_000;
const START = 29_000_000 * MIN;
let dataDir: string;
let app: App;
let servers: Servers;
let admin: User;
let alice: User;
let bob: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-traffic-history-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const person = async (username: string, isAdmin = false): Promise<User> => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "correct-horse-battery", isAdmin });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  admin = await person("keeper", true);
  alice = await person("alice");
  bob = await person("bob");
  setRole(app, admin, "alice", "member");
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const scratch = () => app.db.exec("DELETE FROM traffic_minute; DELETE FROM traffic_hour; DELETE FROM traffic_top");
const note = (l: ReturnType<typeof createTrafficLedger>, at: number, cls: TrafficClass, address: string) =>
  l.note(at, 10, cls, false, { address, family: "chrome", repo: "alice/open", country: "DE", signature: "chrome | en | no referer | none" });
const count = (t: string): number =>
  app.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n;

test("a finished minute is written once, survives the process, and keeps no address", () => {
  scratch();
  const ledger = createTrafficLedger();
  let now = START + 5_000;
  const writer = createTrafficWriter(app.db, ledger, quiet, () => now, 3_600_000);
  note(ledger, now, "deep", "203.0.113.9");
  note(ledger, now, "deep", "203.0.113.10");
  note(ledger, now, "people", "198.51.100.1");
  writer.flush();
  expect(count("traffic_minute")).toBe(0); // the running minute is not finished
  now += MIN;
  writer.flush();
  writer.flush();
  writer.stop();
  const rows = app.db
    .query<{ class: string; requests: number; ms: number; addresses: number }, []>(
      "SELECT class, requests, ms, addresses FROM traffic_minute ORDER BY class",
    )
    .all();
  expect(rows).toEqual([
    { class: "deep", requests: 2, ms: 20, addresses: 2 },
    { class: "people", requests: 1, ms: 10, addresses: 1 },
  ]);

  // A new process: an empty ledger, and the store still answers.
  const after = trafficHistory(app.db, createTrafficLedger(), now, "24h");
  expect(after.classes.deep.requests).toBe(2);
  expect(after.peaks.deep).toBe(2);
  expect(after.tops.repos[0]?.key).toBe("alice/open");
  expect(after.tops.countries[0]?.key).toBe("DE");
  expect(after.tops.prefixes[0]?.key).toBe("203.0.0.0/16");
  const stored = JSON.stringify(app.db.query("SELECT * FROM traffic_top").all());
  expect(stored).not.toContain("203.0.113.9");
  expect(trafficHistory(app.db, createTrafficLedger(), now, "7d").classes.people.requests).toBe(1);
});

test("the running minute counts once, written or not, and two processes in a minute sum", () => {
  scratch();
  const ledger = createTrafficLedger();
  const now = START + 5_000;
  const writer = createTrafficWriter(app.db, ledger, quiet, () => now, 3_600_000);
  note(ledger, now, "other", "203.0.113.9");
  expect(trafficHistory(app.db, ledger, now, "15m").classes.other.requests).toBe(1);
  writer.stop();
  expect(trafficHistory(app.db, ledger, now, "15m").classes.other.requests).toBe(1);
  note(ledger, now, "other", "203.0.113.9"); // late, into a minute already written
  expect(trafficHistory(app.db, ledger, now, "15m").classes.other.requests).toBe(2);

  const next = createTrafficLedger();
  const second = createTrafficWriter(app.db, next, quiet, () => now, 3_600_000);
  note(next, now, "other", "203.0.113.9");
  second.stop();
  const { requests } = app.db
    .query<{ requests: number }, []>("SELECT requests FROM traffic_hour WHERE class = 'other'")
    .get()!;
  expect(requests).toBe(2);
});

test("old rows go, and a closed hour keeps its largest names with the rest summed", () => {
  scratch();
  const hour = Math.floor(START / MIN / 60);
  const insert = app.db.query("INSERT INTO traffic_top VALUES (?1, 'prefixes', ?2, 1, ?3, 1)");
  for (let i = 0; i < HOUR_TOPS + 5; i++) insert.run(hour - 1, `p${i}`, i + 1);
  insert.run(hour - 91 * 24, "ancient", 1);
  app.db.query("INSERT INTO traffic_minute VALUES (?1, 'other', 1, 1, 0, 1)").run(START / MIN - 8 * 24 * 60);
  app.db.query("INSERT INTO traffic_minute VALUES (?1, 'other', 1, 1, 0, 1)").run(START / MIN - 6 * 24 * 60);
  const writer = createTrafficWriter(app.db, createTrafficLedger(), quiet, () => START, 3_600_000);
  writer.stop();
  expect(count("traffic_minute")).toBe(1);
  const names = app.db
    .query<{ key: string; requests: number }, []>("SELECT key, requests FROM traffic_top")
    .all();
  expect(names).toHaveLength(HOUR_TOPS + 1);
  expect(names.find((n) => n.key === "(others)")?.requests).toBe(5);
  expect(names.some((n) => n.key === "ancient" || n.key === "p0")).toBe(false);
});

test("what a request is sorted by: internal, country and signature", () => {
  const trust = { proxies: [] };
  const h = (o: Record<string, string> = {}) => new Headers(o);
  expect(isInternalPeer("127.0.0.1", h(), trust)).toBe(true);
  expect(isInternalPeer("127.0.0.1", h({ "cf-connecting-ip": "203.0.113.9" }), trust)).toBe(false);
  expect(isInternalPeer("127.0.0.1", h({ "x-forwarded-for": "203.0.113.9" }), trust)).toBe(false);
  expect(isInternalPeer("203.0.113.9", h(), trust)).toBe(false);
  expect(isInternalPeer(undefined, h(), trust)).toBe(false);
  expect(classOf({ signedIn: true, internal: true })).toBe("internal");

  expect(countryOf(h({ "cf-ipcountry": "de" }))).toBe("DE");
  expect(countryOf(h({ "cf-ipcountry": "<script>" }))).toBeNull();
  expect(signatureOf("chrome", h({ "accept-language": "en-US,en;q=0.9", referer: "https://x.test/secret?t=1", "sec-fetch-site": "cross-site" }))).toBe(
    "chrome | en-US,en;q=0.9 | referer | cross-site",
  );
  expect(signatureOf("none", h({ "accept-language": `<b>${"x".repeat(99)}`, "sec-fetch-site": "evil" }))).toBe(
    `none | b${"x".repeat(37)} | no referer | no fetch-site`,
  );

  const ledger = createTrafficLedger();
  ledger.note(START, 5, "internal", false, { address: "127.0.0.1", family: "bun", repo: "alice/open", signature: "s" });
  const tops = ledger.tops(START);
  expect(tops.families[0]?.key).toBe("bun");
  expect(tops.repos).toEqual([]);
  expect(tops.prefixes).toEqual([]);
});

test("the page offers the three windows, for an admin alone, and a loopback request is the forge's own", async () => {
  const cookie = `forge_session=${createSession(app.db, admin.id).token}`;
  await fetch(`${servers.url}/`, { redirect: "manual" });
  const own = perfRecord.ledger.totals(Date.now()).classes.internal.requests;
  expect(own).toBeGreaterThan(0);
  const page = await fetch(`${servers.url}/settings/traffic?window=24h`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const text = await page.text();
  for (const w of ["15m", "24h", "7d"]) expect(text).toContain(`/settings/traffic?window=${w}`);
  expect(text).toContain("the forge itself");
  expect(windowOf("nonsense")).toBe("15m");
  const notAdmin = `forge_session=${createSession(app.db, bob.id).token}`;
  expect((await fetch(`${servers.url}/settings/traffic?window=7d`, { headers: { cookie: notAdmin } })).status).toBe(404);
});

test("a deleted repository is named, with how; a private one only to who answers for it", async () => {
  const deletedBy = async (visibility: "public" | "private", name: string): Promise<ForgeEvent> => {
    const made = await actingVia({ userId: alice.id, door: "token:laptop" }, () =>
      createRepo(app, alice, { owner: "alice", name, visibility }),
    );
    if (!made.ok) throw new Error(made.error);
    const created = listEvents(app.db, {})
      .find((e) => e.kind === "repo.created" && e.repoId === made.value.id)!;
    expect(created.payload.door).toBe("token:laptop");
    expect(eventForReader(app.db, undefined)(created).payload.door).toBeUndefined();
    expect(eventForReader(app.db, alice)(created).payload.door).toBe("token:laptop");
    await actingVia({ userId: alice.id, door: "session", via: "conversation:c1" }, () =>
      deleteRepo(app, alice, made.value),
    );
    return listEvents(app.db, {})
      .find((e) => e.kind === "repo.deleted" && e.payload.repo === `alice/${name}`)!;
  };

  const hidden = await deletedBy("private", "secret-plans");
  expect(hidden.payload).toMatchObject({ repo: "alice/secret-plans", visibility: "private", door: "session" });
  expect(hidden.via).toBe("conversation:c1");
  expect(audienceFilter(app.db, undefined)(hidden)).toBe(false);
  expect(audienceFilter(app.db, bob)(hidden)).toBe(false);
  expect(audienceFilter(app.db, alice)(hidden)).toBe(true);
  expect(audienceFilter(app.db, admin)(hidden)).toBe(true);

  const open = await deletedBy("public", "open-plans");
  expect(audienceFilter(app.db, undefined)(open)).toBe(true);
  const told = eventForReader(app.db, bob)(open);
  expect(told.payload.repo).toBe("alice/open-plans");
  expect(told.payload.door).toBeUndefined();
  expect(eventForReader(app.db, admin)(open).payload.door).toBe("session");

  // A row from before: a retired org's named repository, with no visibility.
  const old = { ...hidden, payload: { repo: "acme/x", by: "org_retired" }, actorId: admin.id };
  expect(audienceFilter(app.db, bob)(old)).toBe(false);
});

test("the HTTP door records a token's name, never its secret", async () => {
  const secret = createToken(app.db, alice.id, "laptop", "admin").token;
  const made = await fetch(`${servers.url}/api/v1/repos`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ owner: "alice", name: "by-token" }),
  });
  expect(made.status).toBeLessThan(300);
  const gone = await fetch(`${servers.url}/api/v1/repos/alice/by-token`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(gone.status).toBe(200);
  const event = listEvents(app.db, {})
    .find((e) => e.kind === "repo.deleted" && e.payload.repo === "alice/by-token")!;
  expect(event.payload.door).toBe("token:laptop");
  expect(JSON.stringify(event)).not.toContain(secret);
});
