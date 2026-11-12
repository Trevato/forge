/**
 * An app gets a domain of its own (docs/APPS.md, "Your own domain"): the
 * names it may take, the two records to publish, what a check says, and
 * the moment the forge starts answering there — with a private app's
 * sign-in landing on the new host. DNS is a stand-in the test controls,
 * so nothing here touches the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp, updateAppSettings } from "../src/actions/apps.ts";
import {
  addAppDomain,
  checkAppDomain,
  removeAppDomain,
} from "../src/actions/domains.ts";
import { createRepo } from "../src/actions/repos.ts";
import {
  checkDomain,
  recordsFor,
  type DomainResolver,
} from "../src/apps/domains.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { certificateSaid, probeCertificate } from "../src/apps/certificate.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import { addDomain, getDomain, TOKEN_LENGTH } from "../src/core/domains.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { readRunLogTail } from "../src/runs/log.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const HOST = "app.example.com";
const PROOF = `_forge-verify.${HOST}`;

/** A resolver the test writes the zone of; anything unwritten does not exist. */
class FakeDns implements DomainResolver {
  readonly txt = new Map<string, string[][]>();
  readonly cname = new Map<string, string[]>();
  resolveTxt(name: string): Promise<string[][]> {
    return this.answer(this.txt.get(name));
  }
  resolveCname(name: string): Promise<string[]> {
    return this.answer(this.cname.get(name));
  }
  private answer<T>(found: T | undefined): Promise<T> {
    return found === undefined
      ? Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }))
      : Promise.resolve(found);
  }
}

/** A page with its whitespace collapsed, for asserting on a sentence. */
const words = (html: string): string => html.replace(/\s+/g, " ");

describe("checkDomain: every outcome is a sentence", () => {
  const dns = new FakeDns();
  const token = "abcdefghjkmnpqrstvwxyz01";

  test("nothing published, another value, the proof, and where the name points", async () => {
    expect(await checkDomain(HOST, token, "notes.apps.test", dns)).toEqual({
      verified: false,
      said: `No TXT record at ${PROOF} yet.`,
    });
    dns.txt.set(PROOF, [["forge-verify=somethingelse"]]);
    expect(await checkDomain(HOST, token, "notes.apps.test", dns)).toEqual({
      verified: false,
      said: "The TXT record is there but holds a different value.",
    });
    // The right value beside a wrong one is still the proof; a record split
    // into chunks is read whole.
    dns.txt.set(PROOF, [
      ["forge-verify=somethingelse"],
      ["forge-", `verify=${token}`],
    ]);
    expect(await checkDomain(HOST, token, "notes.apps.test", dns)).toEqual({
      verified: true,
      said: `Verified; ${HOST} has no CNAME yet.`,
    });
    dns.cname.set(HOST, ["Notes.Apps.Test."]);
    expect(await checkDomain(HOST, token, "notes.apps.test", dns)).toEqual({
      verified: true,
      said: `Verified; ${HOST} points at notes.apps.test.`,
    });
    dns.cname.set(HOST, ["elsewhere.example"]);
    expect(await checkDomain(HOST, token, "notes.apps.test", dns)).toEqual({
      verified: true,
      said: `Verified; ${HOST} points at elsewhere.example, not notes.apps.test.`,
    });
  });

  test("a resolver that will not answer is a calm sentence, never a throw", async () => {
    const broken: DomainResolver = {
      resolveTxt: () =>
        Promise.reject(
          Object.assign(new Error("servfail"), { code: "ESERVFAIL" }),
        ),
      resolveCname: () => Promise.reject(new Error("boom")),
    };
    expect(await checkDomain(HOST, token, "notes.apps.test", broken)).toEqual({
      verified: false,
      said: `The DNS lookup for ${PROOF} failed (ESERVFAIL); try again in a minute.`,
    });
    const cnameOnlyBroken: DomainResolver = {
      resolveTxt: () => Promise.resolve([[`forge-verify=${token}`]]),
      resolveCname: () => Promise.reject(new Error("boom")),
    };
    expect(
      await checkDomain(HOST, token, "notes.apps.test", cnameOnlyBroken),
    ).toEqual({
      verified: true,
      said: `Verified; where ${HOST} points could not be looked up.`,
    });
  });

  test("when the box's resolver holds a stale not-found, the zone's own nameservers are asked", async () => {
    const { withAuthority } = await import("../src/apps/domains.ts");
    const asked: string[] = [];
    const stale = {
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })),
      resolveCname: () =>
        Promise.reject(Object.assign(new Error("nx"), { code: "ENODATA" })),
    };
    const authority = {
      resolveNs: (zone: string) => {
        asked.push(`ns ${zone}`);
        return zone === "example.com"
          ? Promise.resolve(["ns1.example.net"])
          : Promise.reject(Object.assign(new Error("nx"), { code: "ENODATA" }));
      },
      resolve4: (host: string) => {
        asked.push(`a ${host}`);
        return Promise.resolve(["192.0.2.53"]);
      },
      resolveTxtAt: (servers: string[], name: string) => {
        asked.push(`txt@${servers.join(",")} ${name}`);
        return Promise.resolve([[`forge-verify=${token}`]]);
      },
    };
    const result = await checkDomain(
      "app.example.com",
      token,
      "notes.apps.test",
      withAuthority(stale, authority),
    );
    expect(result.verified).toBe(true);
    // Walked up past the record's own label and the host, to the zone.
    expect(asked).toEqual([
      "ns app.example.com",
      "ns example.com",
      "a ns1.example.net",
      "txt@192.0.2.53 _forge-verify.app.example.com",
    ]);
    // A stale value from the box's resolver does not hide the authority's.
    const stale2 = withAuthority(
      {
        resolveTxt: () => Promise.resolve([["forge-verify=old-token-value"]]),
        resolveCname: stale.resolveCname,
      },
      authority,
    );
    const fresh = await checkDomain("app.example.com", token, "notes.apps.test", stale2);
    expect(fresh.verified).toBe(true);

    // And a resolver that says something other than "none" is believed.
    const broken = withAuthority(
      {
        resolveTxt: () =>
          Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" })),
        resolveCname: stale.resolveCname,
      },
      authority,
    );
    const failed = await checkDomain("app.example.com", token, "notes.apps.test", broken);
    expect(failed.verified).toBe(false);
    expect(failed.said).toContain("failed");
  });

  test("an apex gets an ALIAS line instead of a CNAME, and is told why", () => {
    expect(recordsFor(HOST, token, "notes.apps.test")).toEqual([
      { type: "TXT", name: PROOF, value: `forge-verify=${token}` },
      { type: "CNAME", name: HOST, value: "notes.apps.test" },
    ]);
    const apex = recordsFor("example.com", token, "notes.apps.test");
    expect(apex[1]?.type).toBe("ALIAS");
    expect(apex[1]?.value).toBe("notes.apps.test");
    expect(apex[1]?.note).toContain("cannot carry a CNAME");
  });
});

describe("an app gets its own domain", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let record: AppRecord;
  let other: AppRecord;
  let otherRepo: Repo;
  let aliceCookie = "";
  let bobCookie = "";
  let adminToken = "";
  let rwToken = "";
  let bobToken = "";
  const dns = new FakeDns();
  let cert: { expires: Date } | { error: string } = {
    expires: new Date(Date.now() + 60 * 86_400_000),
  };

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { host, ...(init.headers as Record<string, string>) },
      redirect: "manual",
    });

  /** A browser's request to the forge itself: a cookie, and a same-origin form. */
  const web = (
    cookie: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== "") headers.set("cookie", cookie);
    const method = init.form !== undefined ? "POST" : (init.method ?? "GET");
    if (init.form !== undefined)
      headers.set("origin", init.origin ?? new URL(servers.url).origin);
    return fetch(`${servers.url}${path}`, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(init.form === undefined
        ? {}
        : { body: new URLSearchParams(init.form) }),
    });
  };
  const flashOf = (response: Response): string =>
    decodeURIComponent(response.headers.get("set-cookie") ?? "");

  const api = (
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string")
      headers.set("content-type", "application/json");
    const token = init.token === undefined ? adminToken : init.token;
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${servers.url}${path}`, { ...init, headers });
  };
  const DOMAINS = "/api/v1/repos/alice/notes/app/domains";

  const signIn = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };

  /** A deploy run as the hook reports it: its state, summary and log tail. */
  const said = (run: Run): string =>
    [
      `deploy ${run.id} is ${run.state}: ${run.summary || "(no summary)"}`,
      ...readRunLogTail(dataDir, run.id, 20).lines,
    ].join("\n");
  /**
   * The deploy's own end: the first matching run that is `ok` or `failed`.
   * Out of time, it names where the latest matching run stood instead.
   */
  async function settled(
    where: (run: Run) => boolean,
    ms = 60_000,
  ): Promise<Run> {
    const deadline = Date.now() + ms;
    let latest: Run | undefined;
    while (Date.now() < deadline) {
      const runs = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 });
      const done = runs.find(
        (r) => where(r) && (r.state === "ok" || r.state === "failed"),
      );
      if (done !== undefined) return done;
      latest = runs.find(where);
      await Bun.sleep(100);
    }
    throw new Error(
      `no deploy settled in ${ms} ms; ${latest === undefined ? "none was queued" : said(latest)}`,
    );
  }
  const kinds = (prefix: string): string[] =>
    listEvents(app.db, { repoId: repo.id, limit: 100 })
      .map((e) => e.kind)
      .filter((k) => k.startsWith(prefix));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-domains-"));
    // The forge's own hostname is `forge.test`: the one name no app may take.
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
      dns,
      certificate: async () => cert,
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
    adminToken = createToken(app.db, alice.id, "admin", "admin").token;
    rwToken = createToken(app.db, alice.id, "rw", "rw").token;
    bobToken = createToken(app.db, bob.id, "admin", "admin").token;

    const made = await newApp(app, alice, {
      name: "notes",
      description: "A place for notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
    // A second app, a row only: enough to contest a name.
    const plain = await createRepo(app, alice, {
      name: "other",
      visibility: "public",
      description: "",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    otherRepo = plain.value;
    const row = insertApp(app.db, {
      repoId: otherRepo.id,
      slug: "other",
      access: "public",
    });
    if (!row.ok) throw new Error(row.error);
    other = row.value;
    const run = await settled((r) => r.env === "production");
    // A failed deploy says why in the check's log, not only "failed".
    if (run.state !== "ok") throw new Error(said(run));
    expect(run.state).toBe("ok");
    expect((await viaHost(`notes.${DOMAIN}`)).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    // A setup that failed part-way leaves later handles unset: stop what started.
    await runtime?.stop();
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("what a domain may be: a hostname someone can own, and not the forge's", () => {
    const add = (host: string) => addAppDomain(app, alice, repo, host);
    for (const bad of ["bad_host", "-x.example.com", "1.2.3.4", "example"]) {
      const refused = add(bad);
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(`${bad}: ${refused.error}`).toBe(`${bad}: invalid_host`);
    }
    for (const ours of ["forge.test", `x.${DOMAIN}`, `a.b.${DOMAIN}`, DOMAIN]) {
      const refused = add(ours);
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(`${ours}: ${refused.error}`).toBe(`${ours}: reserved_host`);
    }
    // A forge whose apps hang off a single label (`--forge.example`)
    // reserves that whole shape, and the zone beneath it.
    const single = {
      forgeHost: "forge.example",
      appHostSuffix: "--forge.example",
    };
    for (const ours of [
      "notes--forge.example",
      "forge.example",
      "a.forge.example",
    ]) {
      const refused = addDomain(
        app.db,
        { host: ours, appId: record.id },
        single,
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(`${ours}: ${refused.error}`).toBe(`${ours}: reserved_host`);
    }
    // Nothing above left a row behind.
    expect(getDomain(app.db, "forge.example")).toBeUndefined();
  });

  test("adding a domain answers with the two records to publish", () => {
    const added = addAppDomain(app, alice, repo, ` App.Example.Com. `);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.host).toBe(HOST);
    expect(added.value.verified).toBe(false);
    expect(added.value.said).toBe("");
    const token = getDomain(app.db, HOST)!.token;
    expect(token).toMatch(new RegExp(`^[0-9a-hjkmnp-tv-z]{${TOKEN_LENGTH}}$`));
    expect(added.value.records).toEqual([
      { type: "TXT", name: PROOF, value: `forge-verify=${token}` },
      { type: "CNAME", name: HOST, value: `notes.${DOMAIN}` },
    ]);
    expect(kinds("app.domain.")).toEqual(["app.domain.added"]);

    // One host, one app: the same name for another app is taken, however
    // it is spelled.
    const contested = addAppDomain(app, alice, otherRepo, "APP.example.com");
    expect(contested.ok).toBe(false);
    if (!contested.ok) expect(contested.error).toBe("taken");
    expect(other.id).not.toBe(record.id);

    // An apex is told to use an ALIAS.
    const apex = addAppDomain(app, alice, repo, "example.com");
    expect(apex.ok).toBe(true);
    if (apex.ok) expect(apex.value.records[1]?.type).toBe("ALIAS");
  });

  test("before verification the forge answers for itself at the host", async () => {
    const page = await viaHost(HOST, "/");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("<h1>notes</h1>");
    expect(
      (await viaHost("forge.test", `/__forge/domains/ask?domain=${HOST}`))
        .status,
    ).toBe(404);
    expect(runtime.urlFor(record, "production")).toBe(
      `http://notes.${DOMAIN}:${servers.port}`,
    );
  });

  test("a check says what it found; the proof verifies the domain", async () => {
    const first = await checkAppDomain(app, alice, repo, HOST);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.verified).toBe(false);
    expect(first.value.said).toBe(`No TXT record at ${PROOF} yet.`);
    expect(first.value.checkedAt).not.toBeNull();

    dns.txt.set(PROOF, [["forge-verify=not-this-one"]]);
    const wrong = await checkAppDomain(app, alice, repo, HOST);
    expect(wrong.ok && wrong.value.said).toBe(
      "The TXT record is there but holds a different value.",
    );
    expect(kinds("app.domain.verified")).toEqual([]);

    const token = getDomain(app.db, HOST)!.token;
    dns.txt.set(PROOF, [[`forge-verify=${token}`]]);
    dns.cname.set(HOST, [`notes.${DOMAIN}`]);
    const right = await checkAppDomain(app, alice, repo, HOST);
    expect(right.ok).toBe(true);
    if (!right.ok) return;
    expect(right.value.verified).toBe(true);
    expect(right.value.verifiedAt).not.toBeNull();
    expect(right.value.said).toBe(
      `Verified; ${HOST} points at notes.${DOMAIN}. ${certificateSaid(
        cert,
        new Date(),
      )}`,
    );
    // A renewal that failed shows on the next check, not on expiry day.
    cert = { expires: new Date(Date.now() - 86_400_000) };
    const lapsed = await checkAppDomain(app, alice, repo, HOST);
    expect(lapsed.ok && lapsed.value.said).toContain("renewal has failed");
    cert = { error: "it could not be reached on port 443" };
    const unread = await checkAppDomain(app, alice, repo, HOST);
    expect(unread.ok && unread.value.said).toContain("Certificate: not read");
    cert = { expires: new Date(Date.now() + 60 * 86_400_000) };
    expect(kinds("app.domain.verified")).toEqual(["app.domain.verified"]);
    // Verified once is verified: a later check leaves its sentence and
    // says so a second time to nobody.
    dns.txt.delete(PROOF);
    const later = await checkAppDomain(app, alice, repo, HOST);
    expect(later.ok && later.value.verified).toBe(true);
    expect(later.ok && later.value.said).toBe(`No TXT record at ${PROOF} yet.`);
    expect(kinds("app.domain.verified")).toEqual(["app.domain.verified"]);
    dns.txt.set(PROOF, [[`forge-verify=${token}`]]);

    // A host that is not this app's is nobody's to check.
    const stranger = await checkAppDomain(app, alice, otherRepo, HOST);
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error).toBe("no_such_domain");
  });

  test("verified, the forge serves the app at the host and every URL follows", async () => {
    const page = await viaHost(HOST, "/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>notes</h1>");
    // The hostname the forge gave it keeps working beside the domain.
    expect(await (await viaHost(`notes.${DOMAIN}`)).text()).toContain(
      "<h1>notes</h1>",
    );
    expect(runtime.urlFor(record, "production")).toBe(`http://${HOST}`);
    expect(runtime.urlFor(record, "pull-3")).toBe(
      `http://notes--3.${DOMAIN}:${servers.port}`,
    );
    expect(runtime.hostFor(record.slug, "production")).toBe(`notes.${DOMAIN}`);
    const json = (await (
      await api("/api/v1/repos/alice/notes/app", { token: null })
    ).json()) as { url: string; domains: string[] };
    expect(json.url).toBe(`http://${HOST}`);
    expect(json.domains).toEqual([HOST]);

    // Caddy's question: is this name anyone's?
    const ask = (domain: string) =>
      viaHost("forge.test", `/__forge/domains/ask?domain=${domain}`);
    const yes = await ask(HOST);
    expect(yes.status).toBe(200);
    expect(await yes.text()).toBe("");
    expect((await ask("APP.EXAMPLE.COM.")).status).toBe(200);
    expect((await ask("example.com")).status).toBe(404);
    expect((await ask("nope.example.com")).status).toBe(404);
    expect((await viaHost("forge.test", "/__forge/domains/ask")).status).toBe(
      404,
    );
  });

  test("a private app's sign-in lands on the new host", async () => {
    expect(updateAppSettings(app, alice, repo, { access: "private" }).ok).toBe(
      true,
    );
    // A person arriving at the domain is sent to the forge to be vouched for.
    const arrived = await viaHost(HOST, "/", {
      headers: { accept: "text/html,*/*" },
    });
    expect(arrived.status).toBe(303);
    const open = new URL(arrived.headers.get("location") ?? "");
    expect(`${open.origin}${open.pathname}`).toBe(`${servers.url}/apps/open`);
    expect(open.searchParams.get("host")).toBe(HOST);
    // A script gets the flat answer.
    expect((await viaHost(HOST, "/")).status).toBe(404);

    // Signed in, alice is sent back to the domain with a grant; following
    // it sets the cookie for that host, and the page opens.
    const vouched = await web(aliceCookie, `${open.pathname}${open.search}`);
    expect(vouched.status).toBe(302);
    const grant = new URL(vouched.headers.get("location") ?? "");
    expect(grant.origin).toBe(`http://${HOST}`);
    expect(grant.pathname).toBe("/__forge/grant");
    const granted = await viaHost(HOST, `${grant.pathname}${grant.search}`);
    expect(granted.status).toBe(303);
    const cookie = granted.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("forge_grant_");
    const greeted = await viaHost(HOST, "/", {
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(greeted.status).toBe(200);
    expect(await greeted.text()).toContain("<b>alice</b>");

    // Someone at the app's own hostname is granted there, port and all,
    // not sent across to the domain.
    const canonical = await web(
      aliceCookie,
      `/apps/open?host=${encodeURIComponent(`notes.${DOMAIN}:${servers.port}`)}&to=/`,
    );
    expect(canonical.status).toBe(302);
    expect(new URL(canonical.headers.get("location") ?? "").host).toBe(
      `notes.${DOMAIN}:${servers.port}`,
    );
    // Bob can read this public repository but not write it, and a private
    // app answers only to its writers and crew (#620, #743): reading is not
    // a key to the app, so he gets the stranger's answer, not a grant.
    expect(
      (await web(bobCookie, `${open.pathname}${open.search}`)).status,
    ).toBe(404);
    expect(updateAppSettings(app, alice, repo, { access: "public" }).ok).toBe(
      true,
    );
  });

  test("the settings page: the card, the records, the badge, and the doors", async () => {
    const settings = "/alice/notes/settings/app";
    const page = words(await (await web(aliceCookie, settings)).text());
    expect(page).toContain("Domains");
    expect(page).toContain(HOST);
    expect(page).toContain(">live<");
    // The apex waits, and shows what to publish.
    expect(page).toContain("waiting for DNS");
    expect(page).toContain("_forge-verify.example.com");
    expect(page).toContain(
      `forge-verify=${getDomain(app.db, "example.com")!.token}`,
    );
    expect(page).toContain("ALIAS");
    expect(page).not.toContain("domain-records");
    // The table is named, and its scroller is a focusable labelled region.
    expect(page).toContain("<caption");
    expect(page).toMatch(
      /<div\s+class="table-scroll"\s+role="region"\s+tabindex="0"\s+aria-label="DNS records for example\.com"/,
    );
    expect(page).toMatch(/<table class="table" data-dense>[\s\S]*?<th>Type<\/th>/);
    // The records wrap instead of truncating (.row-meta only wraps inside
    // .setting-list), carry the type badge, and the whole value is selectable.
    const token = getDomain(app.db, "example.com")!.token;
    expect(page).toContain('<ul class="list setting-list">');
    expect(page).toMatch(/badge[^>]*>\s*TXT\s*</);
    expect(page).toMatch(
      new RegExp(`class="mono record-value" title="forge-verify=${token}"`),
    );
    expect(page).toContain(`${settings}/domains/example.com/check`);
    expect(page).toContain(
      encodeURIComponent(`${settings}/domains/example.com/delete`),
    );
    expect(page).toContain("learns its new address at its next deploy");

    // Adding from the form flashes the records.
    const added = await web(aliceCookie, `${settings}/domains`, {
      form: { host: "staging.example.com" },
    });
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe(settings);
    expect(flashOf(added)).toContain("staging.example.com is added");
    expect(flashOf(added)).toContain("_forge-verify.staging.example.com");
    expect(flashOf(added)).toContain(
      `CNAME from staging.example.com to notes.${DOMAIN}`,
    );
    const refused = await web(aliceCookie, `${settings}/domains`, {
      form: { host: "not a host" },
    });
    expect(flashOf(refused)).toContain("A domain is a hostname");

    // Check now says what it found.
    const checked = await web(
      aliceCookie,
      `${settings}/domains/staging.example.com/check`,
      { form: {} },
    );
    expect(checked.status).toBe(303);
    expect(flashOf(checked)).toContain(
      "No TXT record at _forge-verify.staging.example.com yet.",
    );
    expect(words(await (await web(aliceCookie, settings)).text())).toContain(
      "No TXT record at _forge-verify.staging.example.com yet.",
    );

    // The confirm page knows this door.
    const confirm = await web(
      aliceCookie,
      `/-/confirm?to=${encodeURIComponent(`${settings}/domains/staging.example.com/delete`)}`,
    );
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("Remove staging.example.com?");

    // Not for a non-admin — the one 404 — and not from another origin.
    expect((await web(bobCookie, settings)).status).toBe(404);
    expect(
      (
        await web(bobCookie, `${settings}/domains`, {
          form: { host: "stolen.example.com" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await web(bobCookie, `${settings}/domains/staging.example.com/delete`, {
          form: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await web(aliceCookie, `${settings}/domains`, {
          form: { host: "stolen.example.com" },
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(getDomain(app.db, "stolen.example.com")).toBeUndefined();
    expect(getDomain(app.db, "staging.example.com")).toBeDefined();

    const removed = await web(
      aliceCookie,
      `${settings}/domains/staging.example.com/delete`,
      { form: {} },
    );
    expect(removed.status).toBe(303);
    expect(flashOf(removed)).toContain("staging.example.com is removed");
    expect(getDomain(app.db, "staging.example.com")).toBeUndefined();
    const again = await web(
      aliceCookie,
      `${settings}/domains/staging.example.com/delete`,
      { form: {} },
    );
    expect(flashOf(again)).toContain("No domain by that name");
  });

  test("the API: admin scope and admin over the repository, like the environment", async () => {
    const listed = (await (await api(DOMAINS)).json()) as {
      items: { host: string; verified: boolean; records: unknown[] }[];
    };
    expect(listed.items.map((d) => [d.host, d.verified])).toEqual([
      [HOST, true],
      ["example.com", false],
    ]);
    expect(listed.items[0]?.records).toHaveLength(2);

    const added = await api(DOMAINS, {
      method: "POST",
      body: JSON.stringify({ host: "api.example.com" }),
    });
    expect(added.status).toBe(201);
    const item = (await added.json()) as {
      host: string;
      verified: boolean;
      records: { type: string; name: string }[];
    };
    expect(item.host).toBe("api.example.com");
    expect(item.verified).toBe(false);
    expect(item.records.map((r) => r.type)).toEqual(["TXT", "CNAME"]);
    const refusals: [string, string][] = [
      ["bad_host", "invalid_host"],
      [`x.${DOMAIN}`, "reserved_host"],
      [HOST, "taken"],
    ];
    for (const [host, error] of refusals) {
      const refused = await api(DOMAINS, {
        method: "POST",
        body: JSON.stringify({ host }),
      });
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: string }).error).toBe(error);
    }

    const checked = await api(`${DOMAINS}/api.example.com/check`, {
      method: "POST",
    });
    expect(checked.status).toBe(200);
    expect(((await checked.json()) as { said: string }).said).toBe(
      "No TXT record at _forge-verify.api.example.com yet.",
    );
    expect(
      (await api(`${DOMAINS}/nobody.example.com/check`, { method: "POST" }))
        .status,
    ).toBe(422);

    // The floors: scope, then admin over the repository — a stranger with
    // an admin token is not told the app has domains at all.
    expect((await api(DOMAINS, { token: rwToken })).status).toBe(403);
    expect((await api(DOMAINS, { token: null })).status).toBe(401);
    expect((await api(DOMAINS, { token: bobToken })).status).toBe(404);
    expect(
      (
        await api(DOMAINS, {
          method: "POST",
          body: JSON.stringify({ host: "stolen.example.com" }),
          token: bobToken,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`${DOMAINS}/api.example.com`, {
          method: "DELETE",
          token: rwToken,
        })
      ).status,
    ).toBe(403);
    expect(getDomain(app.db, "api.example.com")).toBeDefined();

    const removed = await api(`${DOMAINS}/api.example.com`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({});
    expect(getDomain(app.db, "api.example.com")).toBeUndefined();
  });

  test("removal makes the host unknown again", async () => {
    const removed = removeAppDomain(app, alice, repo, HOST);
    expect(removed.ok).toBe(true);
    // Newest first: the removal, after everything the page and the API did.
    expect(kinds("app.domain.")[0]).toBe("app.domain.removed");
    expect(kinds("app.domain.removed")).toHaveLength(3);
    const page = await viaHost(HOST, "/");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("<h1>notes</h1>");
    expect(
      (await viaHost("forge.test", `/__forge/domains/ask?domain=${HOST}`))
        .status,
    ).toBe(404);
    expect(runtime.urlFor(record, "production")).toBe(
      `http://notes.${DOMAIN}:${servers.port}`,
    );
    // The name is free again — for anyone, with a new token.
    const oldToken = getDomain(app.db, "example.com")!.token;
    const reclaimed = addAppDomain(app, alice, otherRepo, HOST);
    expect(reclaimed.ok).toBe(true);
    expect(getDomain(app.db, HOST)!.appId).toBe(other.id);
    expect(getDomain(app.db, HOST)!.token).not.toBe(oldToken);
    expect(removeAppDomain(app, alice, repo, HOST).ok).toBe(false);
  });
});

describe("the certificate sentence", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
  test("each side of the boundaries says exactly one thing", () => {
    expect(certificateSaid({ expires: at(-1) }, now)).toBe(
      "Certificate expired on 2026-11-11: renewal has failed.",
    );
    expect(certificateSaid({ expires: at(0) }, now)).toBe(
      "Certificate expires on 2026-11-12 (0 days): it expires soon.",
    );
    expect(certificateSaid({ expires: at(1) }, now)).toBe(
      "Certificate expires on 2026-11-13 (1 day): it expires soon.",
    );
    expect(certificateSaid({ expires: at(14) }, now)).toBe(
      "Certificate expires on 2026-11-26 (14 days): it expires soon.",
    );
    expect(certificateSaid({ expires: at(15) }, now)).toBe(
      "Certificate valid until 2026-11-27.",
    );
    expect(certificateSaid({ error: "it did not resolve" }, now)).toBe(
      "Certificate: not read — it did not resolve. The proxy issues it on the first https request.",
    );
  });

  test("a name that resolves to a private address is never dialled", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          dialled = true;
        },
        data() {},
      },
    });
    let dialled = false;
    const refused = await probeCertificate("rebind.example.com", {
      resolve: async () => ["127.0.0.1"],
      port: server.port,
    });
    await Bun.sleep(50);
    server.stop(true);
    expect(refused).toEqual({ error: "it resolves to a private address" });
    expect(dialled).toBe(false);
    expect(
      await probeCertificate("rebind.example.com", {
        resolve: async () => ["93.184.216.34", "10.0.0.5"],
      }),
    ).toEqual({ error: "it resolves to a private address" });
  });

  test("a closed port and an unresolvable name give a sentence, not a throw", async () => {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open() {}, data() {} },
    });
    const port = probe.port;
    probe.stop(true);
    expect(
      await probeCertificate("closed.example.com", {
        resolve: async () => ["127.0.0.1"],
        allow: ["127.0.0.1"],
        port,
      }),
    ).toEqual({ error: "it could not be reached on port 443" });
    expect(
      await probeCertificate("nowhere.example.com", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).toEqual({ error: "it does not resolve" });
  });
});
