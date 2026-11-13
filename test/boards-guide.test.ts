/** The data explorer starts from a question: plain names, defaults, ready questions, a sentence box. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { aggregateOption, ask, columnOption, defaultsFor, GUIDE, NOTES, parseSentence, QUESTIONS, sentence, unitOf } from "../src/boards/guide.ts";
import { runQuery } from "../src/boards/query.ts";
import { SOURCES } from "../src/boards/sources.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { readParams, toQuery } from "../src/boards/params.ts";

const NOW = Date.parse("2026-11-08T12:00:30Z");

describe("guide", () => {
  test("every source has a plain name and a default that runs", () => {
    expect(Object.keys(GUIDE).sort()).toEqual(Object.keys(SOURCES).sort());
    for (const [s, g] of Object.entries(GUIDE)) {
      if (g.value) expect(SOURCES[s]!.columns[g.value]).toBe("number");
      if (g.filter) expect(SOURCES[s]!.columns[g.filter.column]).toBeDefined();
    }
    expect(GUIDE.machine!.name).toBe("Machine readings");
  });
  test("samples default to an average over time, events to a count per day", () => {
    expect(defaultsFor("machine")).toMatchObject({ aggregate: "avg", column: "cpu_cores", by: "day" });
    expect(defaultsFor("runs")).toMatchObject({ aggregate: "count", column: "", by: "day" });
    const p = readParams(new URLSearchParams("source=machine"));
    expect(p).toMatchObject({ aggregate: "avg", column: "cpu_cores", fcolumn: "target", fvalue: "forge" });
    // an explicit aggregate is never overridden
    expect(readParams(new URLSearchParams("source=machine&aggregate=count")).aggregate).toBe("count");
  });
  test("every ready question is a query the engine accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-boards-questions-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const db = app.db;
    try {
      for (const q of QUESTIONS) {
        const f = ask(q, NOW);
        const p = readParams(new URLSearchParams(f));
        expect(runQuery(db, toQuery(p), { repoIds: "all" }).ok).toBe(true);
      }
      for (const label of ["CPU over the last week", "Slowest pages today", "Who used the forge's time", "Apps shipped per day"]) {
        expect(QUESTIONS.some((q) => q.label === label && q.featured)).toBe(true);
      }
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a chart says what it shows in one line", () => {
    const p = readParams(new URLSearchParams("source=machine&aggregate=avg&column=cpu_cores&by=day&series=target"));
    expect(sentence({ ...p, fcolumn: "", fvalue: "" })).toBe("Average CPU cores per day, by machine.");
    expect(sentence(readParams(new URLSearchParams("source=runs&by=state")))).toBe("Count of runs by state.");
  });
  test("the sentence says the window's bounds: from and to, since, until", () => {
    const at = (q: string) => sentence(readParams(new URLSearchParams(`source=runs&by=state&${q}`)));
    expect(at("from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z")).toBe("Count of runs by state, 2026-11-01 to 2026-11-08.");
    expect(at("from=2026-11-01")).toBe("Count of runs by state, since 2026-11-01.");
    expect(at("to=2026-11-08T00:00:00Z")).toBe("Count of runs by state, until 2026-11-08.");
  });
  test("sum, average and highest name the column they aggregate and its unit", () => {
    expect(aggregateOption("machine", "avg", "memory_bytes")).toEqual(["avg", "average of memory bytes (bytes)"]);
    expect(aggregateOption("spend", "sum")).toEqual(["sum", "total of cost USD (US dollars)"]);
    expect(aggregateOption("machine", "max")[1]).toBe("highest of CPU cores (cores)");
    expect(aggregateOption("runs", "sum")[1]).toBe("total of the column picked below");
  });
  test("a sentence fills the form without a model", () => {
    const m = parseSentence("memory over the last 3 days", NOW)!;
    expect(m).toMatchObject({ source: "machine", column: "memory_bytes", aggregate: "avg", by: "hour", from: "2026-11-05T12:00:00.000Z" });
    expect(parseSentence("Slowest pages today", NOW)).toMatchObject({ source: "reach", by: "route", from: "2026-11-08T00:00:00.000Z" });
    expect(parseSentence("how much did we spend last week", NOW)).toMatchObject({ source: "spend", aggregate: "sum", from: "2026-11-01T12:00:00.000Z" });
    expect(parseSentence("deploys per hour", NOW)).toMatchObject({ source: "deploys", by: "hour" });
    expect(parseSentence("the meaning of life", NOW)).toBeNull();
  });
});

describe("meaning and unit", () => {
  test("every number column of every source names its unit, and the picker shows it", () => {
    for (const [s, src] of Object.entries(SOURCES)) {
      for (const [c, t] of Object.entries(src.columns)) {
        if (t !== "number") continue;
        expect(unitOf(s, c), `${s}.${c}`).not.toBe("");
        expect(columnOption(s, c), `${s}.${c}`).toContain(`(${unitOf(s, c)})`);
      }
    }
    expect(columnOption("machine", "memory_bytes")).toContain("(bytes)");
    expect(columnOption("spend", "cost_usd")).toContain("(US dollars)");
  });
  test("every shared note is for a column some source has", () => {
    const all = new Set(Object.values(SOURCES).flatMap((s) => Object.keys(s.columns)));
    for (const [c, note] of Object.entries(NOTES)) {
      expect(all.has(c), c).toBe(true);
      expect(note, c).not.toBe("");
    }
  });
  test("yesterday is that calendar day, not a sliding window", () => {
    expect(parseSentence("runs yesterday", NOW)).toMatchObject({ from: "2026-11-07T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" });
  });
});

describe("/boards/data", () => {
  let dir = "", app: ReturnType<typeof createApp>, servers: Awaited<ReturnType<typeof serve>>, bearer = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-boards-guide-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!r.ok) throw new Error(r.error);
    bearer = createToken(app.db, r.value.id, "t", "admin").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const get = (path: string, init: RequestInit = {}) => fetch(servers.url + path, { ...init, headers: { authorization: `Bearer ${bearer}` } });

  test("the page names sources plainly, lists ready questions and says what the chart shows", async () => {
    const body = await (await get("/boards/data?source=machine")).text();
    expect(body).toContain("Machine readings");
    expect(body).toContain("Start from a question");
    expect(body).toContain("CPU over the last week");
    expect(body).toContain("Apps shipped per day");
    expect(body).toContain("Average CPU cores per day, where target is forge.");
    expect(body).toContain("counts readings, not time");
    expect(body).toMatch(/cpu_cores \(cores\) — cores in use/);
  });
  test("count on a samples source says what it counts, in the rendered page", async () => {
    const body = await (await get("/boards/data?source=machine")).text();
    expect(body).toMatch(/<option[^>]*value="count"[^>]*>\s*count of 15-second readings \(counts readings, not time\)\s*<\/option>/);
    const events = await (await get("/boards/data?source=runs")).text();
    expect(events).toMatch(/value="count"[^>]*>\s*count of runs\s*</);
  });
  test("a source-list link lands on that source's default chart", async () => {
    const page = await (await get("/boards/data?source=runs&aggregate=count&by=state")).text();
    const href = page.match(/href="(\/boards\/data\?[^"]*)"><strong>Machine readings<\/strong>/)![1]!.replaceAll("&amp;", "&");
    const landed = await (await get(href)).text();
    expect(landed).toContain("Average CPU cores per day, where target is forge.");
    expect(landed).not.toContain("refused");
  });
  test("the page has one primary button", async () => {
    const body = await (await get("/boards/data?source=machine")).text();
    expect(body.match(/data-variant="primary"/g)?.length).toBe(1);
  });
  test("a ready question opens a working chart from its link", async () => {
    const page = await (await get("/boards/data?source=reach")).text();
    const href = page.match(/href="(\/boards\/data\?[^"]*)"><strong>Slowest pages today/)![1]!.replaceAll("&amp;", "&");
    const res = await get(href);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("refused");
  });
  test("a sentence redirects to a link that keeps every choice", async () => {
    const res = await get("/boards/data?ask=memory+over+the+last+3+days", { redirect: "manual" });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!, "http://x");
    expect(loc.searchParams.get("source")).toBe("machine");
    expect(loc.searchParams.get("column")).toBe("memory_bytes");
    expect(loc.searchParams.get("ask")).toBeNull();
  });
  test("a sentence it cannot read says so and still draws the form", async () => {
    const res = await get("/boards/data?ask=zzz+qqq");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("I could not read that");
  });
  test("an empty box is no sentence: the page draws without an error", async () => {
    for (const q of ["ask=", "ask=+++"]) {
      const res = await get(`/boards/data?${q}`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("I could not read that");
    }
  });
  test("the one-line sentence is said once, in the result card's foot", async () => {
    const body = await (await get("/boards/data?source=machine")).text();
    expect(body.split("Average CPU cores per day, where target is forge.").length - 1).toBe(1);
    expect(body).toMatch(/<div class="card-foot">\s*Average CPU cores per day/);
  });
  test("a member who is not a site admin gets 403 for a sentence, and no redirect", async () => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!r.ok) throw new Error(r.error);
    const member = createToken(app.db, r.value.id, "t", "admin").token;
    for (const q of ["ask=memory+over+the+last+3+days", "ask=zzz"]) {
      const res = await fetch(`${servers.url}/boards/data?${q}`, { redirect: "manual", headers: { authorization: `Bearer ${member}` } });
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
    }
    const anon = await fetch(`${servers.url}/boards/data?ask=memory`, { redirect: "manual" });
    expect(anon.status).toBe(404);
  });
});
