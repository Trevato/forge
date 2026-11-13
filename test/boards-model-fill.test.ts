/** The data explorer's model fallback (#9569): rules first, the model only on a miss, its answer checked. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { fillFromSentence, jsonIn, MODEL_FILLED, useModel, validFill, type Ask } from "../src/boards/model_fill.ts";
import { runQuery } from "../src/boards/query.ts";
import { readParams, toQuery } from "../src/boards/params.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { err, ok } from "../src/kernel/result.ts";
import { serve } from "../src/http/server.ts";

const NOW = Date.parse("2026-11-08T12:00:30Z");
const GOOD = { source: "spend", aggregate: "sum", column: "cost_usd", by: "day", chart: "bar", from: "2026-11-01T00:00:00.000Z" };

let calls: string[] = [];
const stub = (reply: string): Ask => async (_app, _user, _system, prompt) => (calls.push(prompt), ok(reply));
afterEach(() => {
  useModel();
  calls = [];
});

describe("validFill", () => {
  test("a fill of real fields passes, and runQuery runs it as it runs any link", () => {
    const fill = validFill(GOOD)!;
    expect(fill).toEqual(GOOD);
    expect(readParams(new URLSearchParams(fill)).column).toBe("cost_usd");
  });
  test("an unknown source, column, aggregate, field or time is refused", () => {
    for (const bad of [
      { ...GOOD, source: "secrets" },
      { ...GOOD, source: "__proto__" },
      { ...GOOD, column: "password_hash" },
      { ...GOOD, series: "nope" },
      { ...GOOD, by: "nope" },
      { ...GOOD, aggregate: "drop" },
      { ...GOOD, fcolumn: "nope", fop: "eq", fvalue: "x" },
      { ...GOOD, fop: "like", fcolumn: "state", fvalue: "x" },
      { ...GOOD, sql: "select 1" },
      { ...GOOD, from: "yesterday-ish" },
      { ...GOOD, column: "" },
      { ...GOOD, rows: "1" },
      { source: "spend" },
      [GOOD],
      "text",
      null,
    ])
      expect(validFill(bad), JSON.stringify(bad)).toBeNull();
  });
  test("jsonIn finds the object in a fenced reply", () => {
    expect(jsonIn('```json\n{"a":"b"}\n```')).toEqual({ a: "b" });
    expect(jsonIn("no object")).toBeNull();
    expect(jsonIn("{broken")).toBeNull();
  });
});

describe("fillFromSentence", () => {
  let dir = "", app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-model-fill-"));
    app = createApp({ dataDir: dir, port: 0 });
  });
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a hit by the rules never calls the model", async () => {
    useModel(stub(JSON.stringify(GOOD)));
    const r = await fillFromSentence(app, "u1", "memory over the last 3 days", NOW);
    expect(r).toMatchObject({ ok: true, by: "rules" });
    expect(calls).toEqual([]);
  });
  test("a miss reaches the model, and its checked answer is the fill", async () => {
    useModel(stub(`Here: ${JSON.stringify(GOOD)}`));
    const r = await fillFromSentence(app, "u2", "how pricey were the robots lately", NOW);
    expect(r).toMatchObject({ ok: true, by: "model", fill: GOOD });
    expect(calls.length).toBe(1);
    if (r.ok) expect(runQuery(app.db, toQuery(readParams(new URLSearchParams(r.fill))), { repoIds: "all" }).ok).toBe(true);
  });
  test("an answer naming an unknown source or column is refused", async () => {
    for (const bad of [{ ...GOOD, source: "users" }, { ...GOOD, column: "secret" }]) {
      useModel(stub(JSON.stringify(bad)));
      expect(await fillFromSentence(app, "u3", "something odd", NOW)).toEqual({ ok: false, why: "refused" });
    }
  });
  test("no model, no account or a blank box is unread, and a blank box costs nothing", async () => {
    useModel(async () => err("off"));
    expect(await fillFromSentence(app, "u4", "zzz", NOW)).toEqual({ ok: false, why: "off" });
    useModel(stub("{}"));
    expect(await fillFromSentence(app, "u4", "   ", NOW)).toEqual({ ok: false, why: "unread" });
    expect(calls).toEqual([]);
  });
  test("the model is asked only a few times a minute per person", async () => {
    useModel(stub("{}"));
    const whys: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await fillFromSentence(app, "u5", "zzz", NOW);
      if (!r.ok) whys.push(r.why);
    }
    expect(whys.filter((w) => w === "limit").length).toBe(2);
    expect(calls.length).toBe(6);
  });
});

describe("/boards/data?ask=", () => {
  let dir = "", app: ReturnType<typeof createApp>, servers: Awaited<ReturnType<typeof serve>>, bearer = "", member = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-model-fill-web-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("users");
    bearer = createToken(app.db, a.value.id, "t", "admin").token;
    member = createToken(app.db, b.value.id, "t", "admin").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const get = (path: string, headers: Record<string, string> = {}, token = bearer) =>
    fetch(servers.url + path, { redirect: "manual", headers: { authorization: `Bearer ${token}`, ...headers } });

  const post = (sentence: string, headers: Record<string, string> = {}) =>
    fetch(servers.url + "/boards/data", { method: "POST", redirect: "manual", body: new URLSearchParams({ ask: sentence }), headers: { authorization: `Bearer ${bearer}`, origin: servers.url, ...headers } });
  test("a miss the model fills is drawn in place, with the note, and no link can claim the note", async () => {
    useModel(stub(JSON.stringify(GOOD)));
    const res = await post("how pricey were the robots");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(MODEL_FILLED);
    expect(page).toContain("Total cost USD per day");
    expect(await (await get("/boards/data?source=spend&aggregate=sum&column=cost_usd&model=1")).text()).not.toContain(MODEL_FILLED);
  });
  test("a hit by the rules redirects without the model and without the note", async () => {
    useModel(stub(JSON.stringify(GOOD)));
    const res = await get("/boards/data?ask=memory+over+the+last+3+days");
    expect(res.status).toBe(303);
    expect(calls).toEqual([]);
  });
  test("a refused answer says so and draws the form", async () => {
    useModel(stub(JSON.stringify({ ...GOOD, source: "users" })));
    const res = await post("zzz qqq");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not a query this explorer can run");
  });
  test("a ?ask= link never spends the model, whatever Sec-Fetch-Site says", async () => {
    useModel(stub(JSON.stringify(GOOD)));
    for (const site of [undefined, "none", "same-origin", "same-site", "cross-site"]) {
      const res = await get("/boards/data?ask=zzz+qqq", site === undefined ? {} : { "sec-fetch-site": site });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("I could not read that");
    }
    expect(calls).toEqual([]);
  });
  test("the page's sentence box posts, and a post from another site is refused before the model", async () => {
    useModel(stub(JSON.stringify(GOOD)));
    expect(await (await get("/boards/data")).text()).toContain('<form method="post" action="/boards/data"');
    expect((await post("zzz qqq", { origin: "https://evil.example" })).status).toBe(403);
    expect(calls).toEqual([]);
  });
  test("a member who is not an admin gets 403 and the model is not asked", async () => {
    useModel(stub(JSON.stringify(GOOD)));
    expect((await get("/boards/data?ask=zzz+qqq", {}, member)).status).toBe(403);
    expect((await fetch(servers.url + "/boards/data", { method: "POST", body: new URLSearchParams({ ask: "zzz" }), headers: { authorization: `Bearer ${member}`, origin: servers.url } })).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
