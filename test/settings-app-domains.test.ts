/** An app's custom domains in Settings: add, check, delete — a repository admin's only (#7023). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import type { DomainResolver } from "../src/apps/domains.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { getDomain } from "../src/core/domains.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const HOST = "shop.example.com";
const PROOF = `_forge-verify.${HOST}`;

class FakeDns implements DomainResolver {
  readonly txt = new Map<string, string[][]>();
  resolveTxt(name: string): Promise<string[][]> {
    const found = this.txt.get(name);
    return found === undefined
      ? Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }))
      : Promise.resolve(found);
  }
  resolveCname(): Promise<string[]> {
    return Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));
  }
}

let dataDir = "";
let app: App, servers: Servers, runtime: AppsRuntime;
const dns = new FakeDns();
const cookies: Record<string, string> = {};

const signIn = async (username: string): Promise<string> => {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
};

/** The form as the page posts it: session cookie, same-origin Origin. */
const post = (who: string, path: string, form: Record<string, string> = {}, origin?: string) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { cookie: cookies[who]!, origin: origin ?? new URL(servers.url).origin },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
const flash = (res: Response): string => {
  const raw = /forge_flash=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return raw === "" ? "" : (JSON.parse(decodeURIComponent(raw)) as { message: string }).message;
};
const DOMAINS = "/acme/shop/settings/app/domains";
const rows = () =>
  app.db.query<{ host: string }, []>("SELECT host FROM app_domain").all().map((r) => r.host);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-set-domains-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
    dns,
  });
  await runtime.start();
  const make = async (username: string) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const founder = await make("founder");
  const dev = await make("dev");
  await make("mallory");
  const org = createOrg(app.db, "acme", founder.id);
  if (!org.ok) throw new Error("org");
  const writers = createTeam(app.db, org.value.id, "Writers", "write");
  if (!writers.ok) throw new Error("team");
  addTeamMember(app.db, writers.value, dev.id);
  for (const [name, visibility] of [["shop", "public"], ["vault", "private"]] as const) {
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: org.value.id, name, visibility });
    if (!repo.ok) throw new Error(String(repo.error));
    const row = insertApp(app.db, { repoId: repo.value.id, slug: name, access: "public" });
    if (!row.ok) throw new Error(row.error);
  }
  for (const who of ["founder", "dev", "mallory"]) cookies[who] = await signIn(who);
}, 30_000);

afterAll(async () => {
  await runtime?.stop();
  servers?.stop();
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("an admin adds a domain, checks it before and after the proof, and deletes it", async () => {
  const added = await post("founder", DOMAINS, { host: HOST });
  expect(added.status).toBe(303);
  expect(added.headers.get("location")).toBe("/acme/shop/settings/app");
  const said = flash(added);
  expect(said).toContain(`${HOST} is added`);
  expect(said).toContain(`a TXT record at ${PROOF}`);
  expect(rows()).toEqual([HOST]);

  const early = flash(await post("founder", `${DOMAINS}/${HOST}/check`));
  expect(early).not.toBe("");
  expect(getDomain(app.db, HOST)?.verifiedAt).toBeNull();

  dns.txt.set(PROOF, [[`forge-verify=${getDomain(app.db, HOST)!.token}`]]);
  await post("founder", `${DOMAINS}/${HOST}/check`);
  expect(getDomain(app.db, HOST)?.verifiedAt).not.toBeNull();

  const gone = await post("founder", `${DOMAINS}/${HOST}/delete`);
  expect(flash(gone)).toBe(`${HOST} is removed. The forge no longer answers there.`);
  expect(rows()).toEqual([]);
  expect(flash(await post("founder", `${DOMAINS}/${HOST}/delete`))).toBe("No domain by that name.");
});

test("a host that is not a hostname is refused with the page's words", async () => {
  const words = "A domain is a hostname: letters, digits and hyphens in at least two labels, like app.example.com.";
  for (const host of ["a b", "http://x", "192.168.0.1", "localhost", ""]) {
    expect(flash(await post("founder", DOMAINS, { host }))).toBe(words);
  }
  expect(flash(await post("founder", DOMAINS, { host: "forge.test" }))).toBe(
    "That name is the forge's own to hand out.",
  );
  expect(rows()).toEqual([]);
});

test("a cross-origin post is refused and adds nothing", async () => {
  const res = await post("founder", DOMAINS, { host: HOST }, "https://evil.example");
  expect(res.status).toBe(403);
  expect(rows()).toEqual([]);
});

test("a writer who is not an admin is refused, as is a stranger who cannot read the repository: both are told not found", async () => {
  // The settings door tells a non-admin nothing: the same answer as no repository.
  for (const path of [DOMAINS, `${DOMAINS}/${HOST}/check`, `${DOMAINS}/${HOST}/delete`]) {
    expect((await post("dev", path, { host: HOST })).status).toBe(404);
  }
  const hidden = await post("mallory", "/acme/vault/settings/app/domains", { host: HOST });
  expect(hidden.status).toBe(404);
  expect(rows()).toEqual([]);
});

test("the domains section is headings over rows, not a card, and says what to publish", async () => {
  await post("founder", DOMAINS, { host: HOST });
  const page = await (
    await fetch(`${servers.url}/acme/shop/settings/app`, { headers: { cookie: `${cookies["founder"]}; forge_mode=dev` } })
  ).text();
  const start = page.indexOf('id="domains"');
  expect(start).toBeGreaterThan(0);
  const section = page.slice(start, page.indexOf("</section>", start));
  expect(section).not.toContain('class="card');
  expect(section).toContain("waiting for DNS");
  expect(section).toContain(PROOF);
  expect(section).toContain(`${DOMAINS}/${HOST}/check`);
  expect(section).toContain(encodeURIComponent(`${DOMAINS}/${HOST}/delete`));
  await post("founder", `${DOMAINS}/${HOST}/delete`);
});
