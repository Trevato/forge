/**
 * Editing an own domain's DNS at the registrar (`app_domains` dns_proof,
 * dns_cut, dns_revert): the credential is the secret DNS_API_TOKEN, the
 * registrar is a stand-in `fetch`, and every cut says what it removed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { editAppDomainDns, parseOldRecords } from "../src/actions/domain_dns.ts";
import { addAppDomain } from "../src/actions/domains.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getRepo } from "../src/core/repos.ts";
import { setSecret } from "../src/core/secret_store.ts";
import { recordCheck } from "../src/core/domains.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { domainsScreen } from "../src/tui/screens/deploys.ts";
import { recordsFromWords } from "../src/tui/screens/domain_dns.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

interface Rec { id: string; type: string; name: string; content: string; ttl: number }

describe("DNS at the registrar", () => {
  let dataDir: string;
  let app: App;
  let runtime: AppsRuntime;
  let alice: User;
  let bob: User;
  let records: Rec[] = [];
  let calls: { method: string; url: string; auth: string | null; body: any }[] = [];
  let failCreate = false;
  let failAll = false;
  let n = 0;

  const ok = (result: unknown) => Response.json({ success: true, result });
  const fake = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, auth: new Headers(init.headers).get("authorization"), body });
    if (u.pathname === "/client/v4/zones")
      return ok(u.searchParams.get("name") === "example.com" ? [{ id: "z1" }] : []);
    if (method === "GET") return ok(records.filter((r) => r.name === u.searchParams.get("name")));
    if (method === "DELETE") {
      records = records.filter((r) => !u.pathname.endsWith(r.id));
      return ok({});
    }
    if (failAll && body.type === "A")
      return Response.json({ success: false, errors: [{ message: "bad tok-123 echoed" }] }, { status: 400 });
    if (failCreate && body.type === "CNAME" && body.content.endsWith("apps.test"))
      return Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 400 });
    const id = `r${n++}`;
    records.push({ id, type: body.type, name: body.name, content: body.content, ttl: body.ttl });
    return ok({ id });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-dns-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    runtime = new AppsRuntime(app, {
      domain: "apps.test", scheme: "http", publicPort: 1, forgeUrl: "http://forge.test",
      concurrency: 1, dnsFetch: fake,
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value; bob = b.value;
    const made = await newApp(app, alice, { name: "notes", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  });
  afterAll(async () => {
    await runtime.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const repo = () => getRepo(app.db, "alice", "notes")!;
  const reset = () => { calls = []; failCreate = false; failAll = false; records = []; };

  test("without the credential nothing is called", async () => {
    reset();
    addAppDomain(app, alice, repo(), "www.example.com");
    const r = await editAppDomainDns(app, alice, repo(), "www.example.com", "proof");
    expect(r).toEqual({ ok: false, error: "no_credential" });
    expect(calls.length).toBe(0);
  });

  test("proof publishes the TXT with the credential from the secret store", async () => {
    reset();
    setSecret(app.db, dataDir, "repo", repo().id, "DNS_API_TOKEN", "tok-123");
    const r = await editAppDomainDns(app, alice, repo(), "www.example.com", "proof");
    expect(r.ok).toBe(true);
    expect(records.map((x) => [x.type, x.name])).toEqual([["TXT", "_forge-verify.www.example.com"]]);
    expect(records[0]!.content).toMatch(/^forge-verify=/);
    expect(calls.every((c) => c.auth === "Bearer tok-123")).toBe(true);
  });

  test("cut needs a verified domain, then replaces the old records and lists them", async () => {
    reset();
    records = [
      { id: "o1", type: "A", name: "www.example.com", content: "203.0.113.5", ttl: 60 },
      { id: "o2", type: "TXT", name: "www.example.com", content: "keep", ttl: 60 },
    ];
    expect(await editAppDomainDns(app, alice, repo(), "www.example.com", "cut")).toEqual({ ok: false, error: "not_verified" });
    expect(records.length).toBe(2);
    recordCheck(app.db, "www.example.com", { verified: true, said: "ok" });
    const r = await editAppDomainDns(app, alice, repo(), "www.example.com", "cut");
    if (!r.ok) throw new Error(String(r.error));
    expect(r.value.removed).toEqual([{ type: "A", name: "www.example.com", value: "203.0.113.5", ttl: 60 }]);
    expect(records[0]!.content).toBe("keep");
    expect(records[1]!.type).toBe("CNAME");
  });

  test("a failed cut puts the removed records back", async () => {
    reset();
    records = [{ id: "o1", type: "A", name: "www.example.com", content: "203.0.113.5", ttl: 60 }];
    failCreate = true;
    const r = await editAppDomainDns(app, alice, repo(), "www.example.com", "cut");
    expect(r).toEqual({ ok: false, error: "refused" });
    expect(records.map((x) => [x.type, x.content])).toEqual([["A", "203.0.113.5"]]);
  });

  test("revert puts the owner's list back, validated", async () => {
    reset();
    const bad = await editAppDomainDns(app, alice, repo(), "www.example.com", "revert", [{ type: "MX", value: "x" }]);
    expect(bad).toEqual({ ok: false, error: "invalid_records" });
    const r = await editAppDomainDns(app, alice, repo(), "www.example.com", "revert", [{ type: "A", value: "203.0.113.5", ttl: 60 }]);
    expect(r.ok).toBe(true);
    expect(records.map((x) => [x.type, x.content, x.ttl])).toEqual([["A", "203.0.113.5", 60]]);
    expect(parseOldRecords("h.example.com", [{ type: "CNAME", value: "a.b" }, { type: "A", value: "1.2.3.4" }])).toBeUndefined();
  });

  test("a non-admin and an unknown domain are refused before the registrar", async () => {
    reset();
    expect((await editAppDomainDns(app, bob, repo(), "www.example.com", "proof")).ok).toBe(false);
    expect(await editAppDomainDns(app, alice, repo(), "nope.example.com", "proof")).toEqual({ ok: false, error: "no_such_domain" });
    expect(calls.length).toBe(0);
  });

  test("an unverified domain cannot be reverted, the registrar is not called", async () => {
    reset();
    addAppDomain(app, alice, repo(), "victim.example.com");
    records = [{ id: "v1", type: "A", name: "victim.example.com", content: "198.51.100.1", ttl: 60 }];
    const r = await editAppDomainDns(app, alice, repo(), "victim.example.com", "revert", [{ type: "A", value: "203.0.113.66" }]);
    expect(r).toEqual({ ok: false, error: "not_verified" });
    expect(calls.length).toBe(0);
    expect(records.map((x) => x.content)).toEqual(["198.51.100.1"]);
  });

  test("a forge-scope token is not used: only the repository's own", async () => {
    reset();
    const other = await newApp(app, alice, { name: "other", description: "x", visibility: "public" });
    if (!other.ok) throw new Error(String(other.error));
    const o = getRepo(app.db, "alice", "other")!;
    addAppDomain(app, alice, o, "o.example.com");
    recordCheck(app.db, "o.example.com", { verified: true, said: "ok" });
    setSecret(app.db, dataDir, "forge", "", "DNS_API_TOKEN", "forge-wide");
    const r = await editAppDomainDns(app, alice, o, "o.example.com", "cut");
    expect(r).toEqual({ ok: false, error: "no_credential" });
    expect(calls.length).toBe(0);
  });

  test("a failure after a partial create deletes what was put and restores what was removed", async () => {
    reset();
    records = [{ id: "o1", type: "A", name: "www.example.com", content: "203.0.113.5", ttl: 60 }];
    const { cloudflare } = await import("../src/apps/dns_provider.ts");
    let creates = 0;
    const flaky = (async (url: string, init: RequestInit) => {
      if ((init.method ?? "GET") === "POST" && ++creates === 2)
        return Response.json({ success: false, errors: [{ message: "boom" }] }, { status: 500 });
      return fake(url, init);
    }) as unknown as typeof fetch;
    const done = await cloudflare("t", flaky).replace(
      "www.example.com", ["A"],
      [
        { type: "A", name: "www.example.com", value: "1.1.1.1", ttl: 60 },
        { type: "A", name: "www.example.com", value: "2.2.2.2", ttl: 60 },
      ],
    );
    expect(done.ok).toBe(false);
    expect(records.map((x) => x.content)).toEqual(["203.0.113.5"]);
  });

  test("a failed rollback hands the removed records back in the answer, token never shown", async () => {
    reset();
    records = [{ id: "o1", type: "A", name: "www.example.com", content: "203.0.113.5", ttl: 60 }];
    failAll = true; // every A create fails: the put and the rollback
    const r = await editAppDomainDns(app, alice, repo(), "www.example.com", "revert", [{ type: "A", value: "203.0.113.9" }]);
    expect(r.ok).toBe(false);
    if (r.ok || typeof r.error === "string") throw new Error("expected a lost answer");
    expect(r.error.unrestored).toEqual([{ type: "A", name: "www.example.com", value: "203.0.113.5", ttl: 60 }]);
    const { dnsRefusal } = await import("../src/actions/domain_dns.ts");
    expect(dnsRefusal(r.error)).toContain("203.0.113.5");
    expect(JSON.stringify(r)).not.toContain("tok-123");
  });

  test("a success is audited as app.domain.dns and no answer holds the token", async () => {
    reset();
    const r = await editAppDomainDns(app, alice, repo(), "www.example.com", "proof");
    expect(JSON.stringify(r)).not.toContain("tok-123");
    const row = app.db
      .query<{ payload: string; actor_id: string }, []>("SELECT payload, actor_id FROM event WHERE kind = 'app.domain.dns' ORDER BY id DESC LIMIT 1")
      .get();
    expect(JSON.parse(row!.payload)).toMatchObject({ host: "www.example.com", step: "proof" });
    expect(row!.actor_id).toBe(alice.id);
  });

  /** The terminal door: the domains screen (`n` on deploys) after `keys`. */
  const drive = async (who: User, of: ReturnType<typeof repo>, keys: string[]): Promise<string> => {
    const terminal = headlessTerminal(200, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
      { terminal, exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(domainsScreen(session, tui.ctx, of));
    await settleApp(tui);
    for (const k of keys) {
      terminal.feed(k);
      await settleApp(tui);
    }
    const text = tui.screen.toText();
    tui.stop();
    return text;
  };

  test("the terminal publishes, cuts over showing what it removed, and puts records back", async () => {
    reset();
    const made = await newApp(app, alice, { name: "shop", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const shop = getRepo(app.db, "alice", "shop")!;
    addAppDomain(app, alice, shop, "shop.example.com");
    setSecret(app.db, dataDir, "repo", shop.id, "DNS_API_TOKEN", "tok-shop");

    expect(await drive(alice, shop, ["p"])).toContain("Published the TXT proof for shop.example.com");
    expect(records.map((x) => [x.type, x.name])).toEqual([["TXT", "_forge-verify.shop.example.com"]]);

    // Unverified: the cut is refused before the registrar.
    records = [{ id: "s1", type: "A", name: "shop.example.com", content: "203.0.113.5", ttl: 60 }];
    calls = [];
    expect(await drive(alice, shop, ["x", "y"])).toContain("Check the domain until it is verified");
    expect(calls.length).toBe(0);

    recordCheck(app.db, "shop.example.com", { verified: true, said: "ok" });
    expect(await drive(alice, shop, ["x"])).toContain("cut shop.example.com over to the app? y/n");
    await drive(alice, shop, ["x", "n"]);
    expect(records.map((x) => x.type)).toEqual(["A"]);
    const cut = await drive(alice, shop, ["x", "y"]);
    expect(cut).toContain("Removed: A 203.0.113.5 ttl 60.");
    expect(cut).not.toContain("tok-shop");
    expect(records.map((x) => x.type)).toEqual(["CNAME"]);

    // The cut's own words, typed back, are the way back.
    await drive(alice, shop, ["v", ..."A 203.0.113.5 ttl 60", "\r"]);
    expect(records.map((x) => [x.type, x.content, x.ttl])).toEqual([["A", "203.0.113.5", 60]]);
    expect(await drive(alice, shop, ["v", ..."MX mail.example.com", "\r"])).toContain("revert needs `records`");
  });

  test("the terminal's registrar keys are not a non-admin's", async () => {
    reset();
    const shop = getRepo(app.db, "alice", "shop")!;
    const seen = await drive(bob, shop, ["x", "y", "p"]);
    expect(seen).toContain("Only the app's admin manages its domains.");
    expect(seen).not.toContain("cut it over");
    expect(calls.length).toBe(0);
  });

  test("typed records become the list the action validates", () => {
    expect(recordsFromWords("A 203.0.113.5 ttl 60; aaaa 2001:db8::1")).toEqual([
      { type: "A", value: "203.0.113.5", ttl: 60 },
      { type: "AAAA", value: "2001:db8::1" },
    ]);
    expect(parseOldRecords("h.example.com", recordsFromWords("A 1.2.3.4 ttl soon"))).toBeUndefined();
  });
});
