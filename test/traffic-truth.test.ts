/** Home's numbers say what they count and can be probed; the traffic tile shows who uses the time; commit-pinned pages are shared only when nothing depends on the viewer. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { familyOf } from "../src/http/crawl.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  trafficAttention,
  trafficValue,
  trafficWords,
} from "../src/flow/kpi_words.ts";
import { readKpis } from "../src/flow/kpis.ts";
import { createPerfRecord, scanTraffic } from "../src/perf/record.ts";
import {
  MAX_KEYS,
  OTHER_KEY,
  createTrafficLedger,
  prefixOf,
  repoOf,
} from "../src/perf/traffic.ts";
import { addressBytes } from "../src/kernel/cidr.ts";
import { kpiRowFor } from "../src/web/studio/kpi_row.ts";
import { probeKpis } from "../src/web/studio/kpi_probe.ts";

const NOW = new Date("2026-11-03T12:00:30Z");
const END = NOW.getTime();
const sample = (
  ms: number,
  o: {
    signedIn?: boolean;
    crawler?: boolean;
    deepStranger?: boolean;
    refused?: boolean;
  } = {},
) => ({ at: END, ms, signedIn: false, phases: [], ...o });

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let sha = "";
let shutSha = "";
const PASSWORD = "a-good-passphrase";

const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, {
    headers: { "user-agent": BROWSER, ...headers },
    redirect: "manual",
  });
const SHARED = "public, max-age=31536000, s-maxage=86400, immutable";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-traffic-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: PASSWORD, isAdmin: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const other = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: PASSWORD });
  if (!other.ok) throw new Error(other.error);
  bob = other.value;
  for (const [name, visibility] of [["open", "public"], ["shut", "private"]] as const) {
    const repo = await createRepo(app, alice, { name, visibility });
    if (!repo.ok) throw new Error(String(repo.error));
    const put = await commitToBranch(app, alice, getRepo(app.db, "alice", name)!, { message: "Start", files: [{ path: "a.txt", content: "hi\n" }] });
    if (!put.ok) throw new Error(String(put.error));
    // The commit's own id, from the write that made it: no second git process to fail quietly under load.
    const oid = put.value.commitOid;
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid)) throw new Error(`no full id for ${name}: ${oid}`);
    if (name === "open") sha = oid;
    else shutSha = oid;
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const mintToken = async (username: string, scope: string): Promise<string> => {
  const res = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: scope === "admin", username, password: PASSWORD, name: "t", scope }),
  });
  return ((await res.json()) as { token: string }).token;
};

test("the ledger counts each class exactly, even where the samples are thinned", () => {
  const record = createPerfRecord();
  record.add("/a", sample(100, { signedIn: true }));
  record.add("/a", sample(200, { crawler: true }));
  record.add("/a", sample(900, { deepStranger: true }));
  record.add("/a", sample(1, { deepStranger: true, refused: true }));
  record.add("/a", sample(50));
  const t = record.ledger.totals(END);
  expect(t.requests).toBe(5);
  expect(t.refused).toBe(1);
  expect(t.classes.people).toEqual({ requests: 1, ms: 100, refused: 0 });
  expect(t.classes.crawlers.ms).toBe(200);
  expect(t.classes.deep).toEqual({ requests: 2, ms: 901, refused: 1 });
  expect(t.classes.other.requests).toBe(1);
  expect(t.minutes).toHaveLength(15);
  expect(scanTraffic(record, t.since, END).deep).toEqual({
    requests: 2,
    ms: 901,
    refused: 1,
  });

  const busy = createPerfRecord();
  for (let i = 0; i < 25_000; i++)
    busy.add("/b", sample(1, { deepStranger: true }));
  expect(busy.ledger.totals(END).classes.deep.requests).toBe(25_000);
  expect(busy.traffic("/b", 0).length).toBeLessThan(25_000);
});

test("a minute past the window falls out, and a bucket is reused for the next quarter hour", () => {
  const ledger = createTrafficLedger();
  ledger.note(END, 10, "other", false);
  expect(ledger.totals(END).requests).toBe(1);
  expect(ledger.totals(END + 14 * 60_000).requests).toBe(1);
  expect(ledger.totals(END + 15 * 60_000).requests).toBe(0);
  ledger.note(END + 15 * 60_000, 20, "people", false);
  expect(ledger.totals(END + 15 * 60_000).classes.people.ms).toBe(20);
  expect(ledger.totals(END + 15 * 60_000).classes.other.requests).toBe(0);
});

test("it keeps prefixes and a sketch, never an address, and its tables are bounded", () => {
  const ledger = createTrafficLedger();
  for (let i = 0; i < 1792; i++)
    ledger.note(END, 1, "deep", false, {
      address: `198.${(i >> 8) & 255}.${i & 255}.7`,
      family: "chrome",
      repo: "alice/open",
    });
  const t = ledger.totals(END);
  expect(Math.abs(t.addresses - 1792)).toBeLessThan(1792 * 0.12);
  const tops = ledger.tops(END, 500);
  expect(JSON.stringify([t, tops])).not.toContain(".7");
  expect(tops.prefixes[0]!.key).toBe("198.0.0.0/16");
  expect(tops.prefixes[0]!.anonymous).toBe(256);
  expect(tops.families).toEqual([
    { key: "chrome", requests: 1792, ms: 1792, anonymous: 1792 },
  ]);

  const few = createTrafficLedger();
  for (const address of ["10.0.0.1", "10.0.0.2", "10.0.0.2", "10.0.0.3"])
    few.note(END, 1, "other", false, { address, family: "curl", repo: null });
  expect(few.totals(END).addresses).toBe(3);
  few.note(END, 1, "other", false, {
    address: "unknown",
    family: "curl",
    repo: null,
  });
  expect(few.tops(END).prefixes.map((r) => r.key)).toContain("unknown");

  const crowded = createTrafficLedger();
  for (let i = 0; i < 5000; i++)
    crowded.note(END, 1, "other", false, {
      address: "10.0.0.1",
      family: `f${i}`,
      repo: null,
    });
  const families = crowded.tops(END, 10_000).families;
  expect(families.length).toBeLessThanOrEqual(MAX_KEYS);
  expect(families.find((r) => r.key === OTHER_KEY)!.requests).toBeGreaterThan(
    4000,
  );

  expect(prefixOf(addressBytes("2001:db8:1::2")!)).toBe("2001:db8::/32");
  expect(prefixOf(addressBytes("::ffff:203.0.113.9")!)).toBe("203.0.0.0/16");
  expect(
    repoOf("/:owner/:name/blob/:ref/*path", "/alice/open/blob/x/a.txt"),
  ).toBe("alice/open");
  expect(
    repoOf(
      "/origins/:id/r/:owner/:name/tree/:ref",
      "/origins/o1/r/bob/lib/tree/x",
    ),
  ).toBe("bob/lib");
  expect(repoOf("/settings/traffic", "/settings/traffic")).toBeNull();
  expect(familyOf(BROWSER)).toBe("chrome");
  expect(familyOf("Mozilla/5.0 (compatible; Reflectionbot/1.0)")).toBe(
    "reflectionbot",
  );
  expect(familyOf("curl/8.1")).toBe("curl");
  expect(familyOf("")).toBe("none");
});

test("the tile says plainly when strangers hold most of the time, and not for a handful", () => {
  const flood = createPerfRecord();
  for (let i = 0; i < 40; i++)
    flood.add("/a", sample(100, { deepStranger: true }));
  flood.add("/a", sample(100, { signedIn: true }));
  const t = flood.ledger.totals(END);
  expect(trafficAttention(t)).toBe("deep");
  expect(trafficValue(t)).toBe("98%");
  expect(trafficWords(t).note).toContain("too much");
  expect(trafficWords(t).title).toStartWith("Something is wrong");
  const row = String(kpiRowFor(emptyKpis(), null, NOW, t));
  // The home row no longer carries a Traffic tile; the board at /settings/traffic does.
  expect(row).not.toContain("/settings/traffic");

  const handful = createPerfRecord();
  handful.add("/a", sample(5000, { deepStranger: true }));
  expect(trafficAttention(handful.ledger.totals(END))).toBeNull();
  expect(
    String(kpiRowFor(emptyKpis(), null, NOW, handful.ledger.totals(END))),
  ).not.toContain("/settings/traffic");

  expect(trafficValue(createPerfRecord().ledger.totals(END))).toBe("—");
});

function emptyKpis() {
  return readKpis(app.db, NOW, { ceilingUsd: 40 });
}

/** What each tile in the row shows, by its label, with the markup taken off. */
function tileValues(row: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of row.matchAll(
    /stat-label">([^<]+)<\/span><span class="stat-value num"[^>]*>(.*?)<\/span>(?=<span class="stat-note|<\/a>)/gs,
  ))
    out.set(
      m[1]!.trim().replace(/&#39;/g, "'"),
      m[2]!.replace(/<[^>]+>/g, "").trim(),
    );
  return out;
}

test("every tile's value equals the probe's, from known requests and page_vital rows", () => {
  const today = NOW.toISOString().slice(0, 10);
  const yesterday = new Date(END - 86_400_000).toISOString().slice(0, 10);
  const insert = app.db.query("INSERT INTO page_vital (day, at, route, visitor, load, inp, cls) VALUES (?1, 0, '/', ?2, ?3, ?4, 0)");
  for (const [day, visitor, load, inp] of [
    [today, "v1", 100, 10],
    [today, "v1", 200, 20],
    [today, "v2", 300, null],
    [yesterday, "v1", 900, 40],
    [today, "v3", null, null],
  ] as const)
    insert.run(day, visitor, load, inp);
  const record = createPerfRecord();
  record.add("/a", sample(300, { signedIn: true }));
  for (let i = 0; i < 3; i++)
    record.add("/a", sample(900, { deepStranger: true }));

  const kpis = readKpis(app.db, NOW, { ceilingUsd: 40 });
  const live = { sha: "a".repeat(40), at: "2026-11-03T11:00:00Z" };
  const traffic = record.ledger.totals(END);
  const tiles = tileValues(String(kpiRowFor(kpis, live, NOW, traffic)));
  const probe = probeKpis(
    app.db,
    NOW,
    { kpis, live },
    { ceilingUsd: 40 },
    record,
  );

  // Four distinct browsers would be a lie: three reported today, one of them twice.
  const byId = new Map(probe.numbers.map((n) => [n.id, n]));
  expect(byId.get("visitors")!.value).toBe("3 today");
  expect(byId.get("visitors")!.inputs).toMatchObject({
    browsers_today: 3,
    browsers_summed_7d: 4,
  });
  // Loads 100, 200, 300, 900: rank ⌈0.75·4⌉ = 3 is 300.
  expect(byId.get("speed")!.value).toBe("300 ms");
  expect(byId.get("speed")!.inputs).toMatchObject({
    views_with_load_7d: 4,
    load_p75_ms: 300,
    views_with_inp_7d: 3,
  });
  expect(byId.get("traffic")!.value).toBe("90%");
  expect(byId.get("traffic")!.inputs).toMatchObject({
    samples: { deep: { requests: 3, ms: 2700 } },
    ledger: { deep: { requests: 3, ms: 2700 } },
  });

  expect(probe.numbers.length).toBe(11);
  for (const n of probe.numbers) {
    expect(n.counts.length).toBeGreaterThan(10);
    expect([n.id, n.agrees, n.recomputed]).toEqual([n.id, true, n.value]);
    // These figures are the probe's and the boards', no longer tiles on the home row.
    if (["traffic", "visitors", "users", "accounts"].includes(n.id)) {
      expect([n.id, tiles.has(n.label)]).toEqual([n.id, false]);
      continue;
    }
    const shown = tiles.get(n.label);
    expect([n.label, n.id === "live" ? shown !== undefined : shown]).toEqual([
      n.label,
      n.id === "live" ? true : n.value,
    ]);
  }
  expect(tiles.size).toBe(probe.numbers.length - 3);
  // The live tile's short form is the start of the probe's full id.
  expect(byId.get("live")!.value.startsWith(tiles.get("Live version")!)).toBe(
    true,
  );

  // The probe reads past what the tile holds: a report after the tile was computed disagrees.
  insert.run(today, "v9", 100, null);
  const later = probeKpis(
    app.db,
    NOW,
    { kpis, live },
    { ceilingUsd: 40 },
    record,
  );
  const visitors = later.numbers.find((n) => n.id === "visitors")!;
  expect([visitors.value, visitors.recomputed, visitors.agrees]).toEqual([
    "3 today",
    "4 today",
    false,
  ]);
});

test("a stranger's deep read reaches the record with its class, and the board and probe are an admin's alone", async () => {
  await get(`/alice/open/blob/${sha}/a.txt`, { "x-forwarded-for": "203.0.113.200" });
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const notAdmin = `forge_session=${createSession(app.db, bob.id).token}`;

  const board = await get("/settings/traffic", { cookie });
  expect(board.status).toBe(200);
  const text = await board.text();
  expect(text).toContain("anonymous deep pages");
  expect(text).toContain("alice/open");
  expect(text).toContain("<svg");
  expect(text).not.toContain("203.0.113.200");
  expect(board.headers.get("cache-control") ?? "").not.toContain("public");

  expect((await get("/settings/traffic", { cookie: notAdmin })).status).toBe(403);
  expect((await get("/settings/traffic")).status).toBeGreaterThanOrEqual(300);
  expect((await get("/api/v1/admin/kpis/probe")).status).toBe(404);
  expect((await get("/api/v1/admin/kpis/probe", { authorization: `Bearer ${await mintToken("bob", "read")}` })).status).toBe(404);

  const probe = await get("/api/v1/admin/kpis/probe", { authorization: `Bearer ${await mintToken("alice", "admin")}` });
  expect(probe.status).toBe(200);
  const answer = (await probe.json()) as { numbers: { id: string; counts: string }[] };
  expect(answer.numbers.map((n) => n.id)).toContain("traffic");
  expect(JSON.stringify(answer)).not.toContain("203.0.113.200");
});

test("an anonymous page at a full commit is the same bytes twice, with no cookie and no per-request content", async () => {
  const one = await get(`/alice/open/blob/${sha}/a.txt`, {
    "x-forwarded-for": "203.0.113.1",
  });
  const two = await get(`/alice/open/blob/${sha}/a.txt`, {
    "x-forwarded-for": "203.0.113.2",
  });
  expect(one.headers.get("cache-control")).toBe(SHARED);
  expect(one.headers.get("set-cookie")).toBeNull();
  const a = await one.text();
  expect(a).toBe(await two.text());
  expect(a).not.toMatch(/csrf|nonce=|203\.0\.113/i);
});

test("each pinned route is shared when anonymous and never otherwise", async () => {
  const session = `forge_session=${createSession(app.db, alice.id).token}`;
  for (const path of [
    `tree/${sha}`,
    `blob/${sha}/a.txt`,
    `raw/${sha}/a.txt`,
    `media/${sha}/a.txt`,
  ]) {
    const url = `/alice/open/${path}`;
    const anonymous = await get(url);
    expect([
      path,
      anonymous.status,
      anonymous.headers.get("cache-control"),
    ]).toEqual([path, 200, SHARED]);
    expect(anonymous.headers.get("vary")).toContain("Cookie");
    expect(anonymous.headers.get("vary")).toContain("Authorization");
    for (const headers of [
      { cookie: session },
      { cookie: "forge_theme=dark" },
      { cookie: "forge_flash=hello" },
      { cookie: "forge_session=expired" },
      { authorization: "Bearer nothing" },
    ]) {
      const res = await get(url, headers);
      expect([
        path,
        Object.keys(headers)[0],
        res.headers.get("cache-control") ?? "",
      ]).not.toEqual([
        path,
        Object.keys(headers)[0],
        expect.stringContaining("public"),
      ]);
    }
    // A branch name moves.
    const moving = await get(`/alice/open/${path.replace(sha, "main")}`);
    expect(moving.headers.get("cache-control") ?? "").not.toContain(
      "immutable",
    );
    expect(moving.headers.get("cache-control") ?? "").not.toContain("public");
  }
});

test("a private repository is never shared, to its owner or to anyone else", async () => {
  const session = `forge_session=${createSession(app.db, alice.id).token}`;
  for (const path of [`tree/${shutSha}`, `blob/${shutSha}/a.txt`, `raw/${shutSha}/a.txt`, `media/${shutSha}/a.txt`]) {
    const own = await get(`/alice/shut/${path}`, { cookie: session });
    expect([path, own.status]).toEqual([path, 200]);
    expect(own.headers.get("cache-control") ?? "").not.toContain("public");
    const stranger = await get(`/alice/shut/${path}`);
    expect(stranger.status).toBe(404);
    expect(stranger.headers.get("cache-control") ?? "").not.toContain("public");
  }
});

test("a repository that turns private stops being shared on its next answer", async () => {
  const pinned = `/alice/open/raw/${sha}/a.txt`;
  expect((await get(pinned)).headers.get("cache-control")).toBe(SHARED);
  app.db.run("UPDATE repo SET visibility = 'private' WHERE id = ?1", [getRepo(app.db, "alice", "open")!.id]);
  const after = await get(pinned);
  expect(after.status).toBe(404);
  expect(after.headers.get("cache-control") ?? "").not.toContain("public");
  app.db.run("UPDATE repo SET visibility = 'public' WHERE id = ?1", [getRepo(app.db, "alice", "open")!.id]);
});
