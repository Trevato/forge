/**
 * The one-click connect, brokered by a parent for the forges it hosts: a
 * parent and two children (the spawn tests' pair), a fake provider, and the
 * threats the flow exists to survive. The provider's own pages are the test's
 * hand: it reads the authorize URL and answers the callback.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAllowed } from "../src/apps/egress.ts";
import { childOriginHosts } from "../src/core/capacity.ts";
import { createRepo } from "../src/actions/repos.ts";
import { beatKeyOf, childDirOf } from "../src/actions/spawn.ts";
import {
  completeBrokeredCallback,
  pollOAuthConnect,
  startOAuthConnect,
} from "../src/actions/origins.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { listEvents } from "../src/core/events.ts";
import { getCursor, getOriginById, sealedSecrets } from "../src/core/origins.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import type { Ctx } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { open } from "../src/kernel/secret.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";
import {
  BROKERED,
  VIA_PARENT,
  brokerOffers,
  callParent,
  forgetOffers,
} from "../src/origins/broker.ts";
import { providerForOrigin } from "../src/origins/credential.ts";
import { discover } from "../src/origins/discover.ts";
import { flowSecrets } from "../src/origins/oauth.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { SIGNATURE_HEADER } from "../src/spawn/heartbeat.ts";
import {
  answerBrokerCall,
  brokerCallback,
  brokerStart,
  CODE_TTL_MS,
} from "../src/spawn/origin_broker.ts";
import {
  BROKER_CALL,
  BROKER_CALLBACK,
  BROKER_START,
  signWith,
  startText,
} from "../src/spawn/origin_broker_wire.ts";
import { openBeatDoor, parentLocal } from "../src/spawn/beat-door.ts";
import { childPublicUrl } from "../src/spawn/placement.ts";
import { newFakeOAuth, newFakeState, serveFakeForge, type FakeForge, type FakeOAuth } from "./fake-origin.ts";
import { everyoneIsAMember } from "./helpers/members.ts";
import { withoutEnv } from "./helpers/globals.ts";

withoutEnv("FORGE_URL");

const PASSWORD = "alice-login-secret";
const CLIENT_ID = "broker-client-id";
const LOGIN = "octo";
const PARENT_URL = "https://forge.test";

const basic = (user: string): string => `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}`;

interface Kid {
  readonly name: string;
  readonly app: App;
  readonly servers: Servers;
  readonly key: string;
}

let dir = "";
let parent: App;
let parentServers: Servers;
let maria: Kid;
let otto: Kid;
let code: { fake: FakeForge; oauth: FakeOAuth };
let device: { fake: FakeForge; oauth: FakeOAuth };
let current: { fake: FakeForge; oauth: FakeOAuth };
const realFetch = globalThis.fetch;
const callsMade: { op: string }[] = [];
const level = logLevel();
/** The parent's environment. The children share this process, and have none of it: a hosted forge holds no application. */
const penv: Record<string, string | undefined> = {};
const deps = () => ({ discover: standIn, env: penv });

/** What the parent finds when asked about the host the child named: the fake standing there. */
const standIn: typeof discover = (input) =>
  discover({ host: current.fake.url, ...(typeof input === "string" || input.kind === undefined ? {} : { kind: input.kind }) });

async function boot(name: string): Promise<Kid> {
  const parentToken = createToken(parent.db, getUserByName(parent.db, "alice")!.id, "rw", "rw").token;
  const made = await realFetch(`${parentServers.url}/api/v1/forges`, {
    method: "POST",
    headers: { authorization: `Bearer ${parentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, apps: ["alice/bakery"], dryRun: false }),
  });
  if (made.status !== 201) throw new Error(`spawn ${made.status}`);
  const { bodyId } = (await made.json()) as { bodyId: string };
  const app = createApp({ dataDir: childDirOf(parent, bodyId), port: 0 });
  await firstBoot(app);
  // The child reaches its parent where the test serves it, not at the parent's public name.
  const file = join(app.config.dataDir, "parent.json");
  const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...doc, upstream: parentServers.url }));
  everyoneIsAMember(app.db);
  for (const username of ["ana", "bob", "carol"]) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.test`, password: PASSWORD });
    if (!made.ok) throw new Error(`user ${username}`);
  }
  const servers = await serve(app);
  return { name, app, servers, key: (await beatKeyOf(parent, name)) ?? "" };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-broker-"));
  parent = createApp({ dataDir: dir, url: PARENT_URL, port: 0 });
  const alice = await createUser(parent.db, {
    origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: PASSWORD, isAdmin: true,
  });
  if (!alice.ok) throw new Error("user");
  const repo = await createRepo(parent, alice.value, { name: "bakery" });
  if (!repo.ok) throw new Error("repo");
  const committed = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
    branch: "main", message: "bakery", files: [{ path: "README.md", content: "# bakery\n" }],
    author: { name: "a", email: "a@x.invalid" },
  });
  if (!committed.ok) throw new Error("commit");
  parentServers = await serve(parent);
  // The parent holds an application for the host the fake stands in for (the operator's, PKCE, no secret).
  penv.FORGE_ORIGIN_CLIENT_ID = `localhost=${CLIENT_ID}`;
  maria = await boot("maria");
  otto = await boot("otto");

  const forgejo = newFakeState("forgejo", LOGIN, "unused-pat");
  const forgejoOauth = newFakeOAuth(CLIENT_ID);
  forgejo.oauth = forgejoOauth;
  code = { fake: serveFakeForge(forgejo), oauth: forgejoOauth };
  const github = newFakeState("github", LOGIN, "unused-pat");
  const githubOauth = newFakeOAuth(CLIENT_ID);
  github.oauth = githubOauth;
  device = { fake: serveFakeForge(github), oauth: githubOauth };
  current = code;

  // The parent's own `discover` would look for `https://localhost`; its calls from a child are answered in
  // process with the fake standing there. Every other request goes where it was sent.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${parentServers.url}${BROKER_CALL}` && init?.body !== undefined) {
      const body = String(init.body);
      callsMade.push({ op: (JSON.parse(body) as { op: string }).op });
      const headers = init.headers as Record<string, string>;
      return answerBrokerCall(parent, body, headers[SIGNATURE_HEADER] ?? null, deps());
    }
    return realFetch(input, init);
  }) as typeof fetch;
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  setLogLevel(level);
  code.fake.stop();
  device.fake.stop();
  for (const k of [maria, otto]) {
    k.servers.stop();
    k.app.close();
  }
  parentServers.stop();
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

const asUser = (kid: Kid, name: string) => getUserByName(kid.app.db, name)!;
const brokerRows = () => parent.db.query<Record<string, unknown>, []>("SELECT * FROM origin_broker").all();
const fresh = (kid: Kid): void => {
  kid.app.db.query("DELETE FROM origin").run();
  kid.app.db.query("DELETE FROM oauth_flow").run();
  parent.db.query("DELETE FROM origin_broker").run();
};

const parentCtx = (url: URL, cookie = ""): Ctx =>
  ({ app: parent, url, request: new Request(url.toString(), cookie === "" ? {} : { headers: { cookie } }) }) as unknown as Ctx;

interface Signed {
  readonly flowId: string;
  readonly start: URL;
  readonly state: string;
  readonly challenge: string;
}

/** The click: the child starts a brokered sign-in for `who`; what the browser is sent to. */
async function click(kid: Kid, who: string, host = code.fake.url): Promise<Signed> {
  const started = await startOAuthConnect(kid.app, asUser(kid, who), { host });
  if (!started.ok) throw new Error(`start refused: ${started.error.message}`);
  expect(started.value.brokered).toBe(true);
  const start = new URL(started.value.url);
  return {
    flowId: started.value.flowId,
    start,
    state: start.searchParams.get("state")!,
    challenge: start.searchParams.get("challenge")!,
  };
}

/** The parent's start, then the provider saying yes: what the parent answers the browser with. */
async function sayYes(s: Signed, extra = "", via: "http" | "direct" = "direct"): Promise<{ back: Response; cookie: string; authorize: URL }> {
  const start = new URL(s.start);
  if (extra !== "") for (const [k, v] of new URLSearchParams(extra)) start.searchParams.set(k, v);
  const go = await brokerStart(parentCtx(start), `${parentServers.url}/settings/origins/callback`, deps());
  expect(go.status).toBe(303);
  const authorize = new URL(go.headers.get("location")!);
  const cookie = (go.headers.get("set-cookie") ?? "").split(";")[0]!;
  const at = `${parentServers.url}/settings/origins/callback?state=${encodeURIComponent(authorize.searchParams.get("state")!)}&code=${code.oauth.authCode}`;
  const back =
    via === "http"
      ? await realFetch(at, { headers: { cookie }, redirect: "manual" })
      : ((await brokerCallback(parentCtx(new URL(at), cookie), deps())) ?? new Response("not a brokered state", { status: 500 }));
  return { back, cookie, authorize };
}

/** The browser arriving back at the child, as `who`. */
const arrive = (kid: Kid, location: URL, who: string): Promise<Response> =>
  realFetch(`${kid.servers.url}${location.pathname}${location.search}`, {
    headers: { authorization: basic(who) },
    redirect: "manual",
  });

describe("what a hosted forge is offered", () => {
  test("it learns kinds and names from its parent, and never an application's id or secret", async () => {
    const offers = await brokerOffers(maria.app);
    expect(offers).toEqual([{ host: "localhost", kind: "forgejo", name: "localhost" }]);
    expect(JSON.stringify(offers)).not.toContain(CLIENT_ID);
    // GitHub is offered when the parent has its client id.
    penv.FORGE_GITHUB_CLIENT_ID = "Iv1.parent";
    penv.FORGE_GITHUB_CLIENT_SECRET = "github-secret-never-sent";
    try {
      forgetOffers(maria.app);
      const both = await brokerOffers(maria.app);
      expect(both.map((o) => `${o.kind}:${o.host}:${o.name}`)).toEqual(["github:github.com:GitHub", "forgejo:localhost:localhost"]);
      const text = JSON.stringify(both);
      expect(text).not.toContain("Iv1.parent");
      expect(text).not.toContain("github-secret-never-sent");
    } finally {
      delete penv.FORGE_GITHUB_CLIENT_ID;
      delete penv.FORGE_GITHUB_CLIENT_SECRET;
      forgetOffers(maria.app);
    }
  });

  test("a forge with no parent, or a parent with no application, is offered nothing and asks nobody", async () => {
    expect(await brokerOffers(parent)).toEqual([]);
    const saved = penv.FORGE_ORIGIN_CLIENT_ID;
    delete penv.FORGE_ORIGIN_CLIENT_ID;
    try {
      forgetOffers(otto.app);
      expect(await brokerOffers(otto.app)).toEqual([]);
      const started = await startOAuthConnect(otto.app, asUser(otto, "ana"), { host: code.fake.url });
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.error.error).toBe("no_app");
    } finally {
      penv.FORGE_ORIGIN_CLIENT_ID = saved;
      forgetOffers(otto.app);
    }
  });

  test("the Origins page leads with the button and keeps the token form as the quiet fallback", async () => {
    forgetOffers(maria.app);
    const signin = await realFetch(`${maria.servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "ana", password: PASSWORD }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await realFetch(`${maria.servers.url}/settings/origins`, { headers: { cookie } })).text();
    expect(page).toContain("data-parent-signin");
    expect(page).toContain("Connect localhost");
    expect(page).toContain("Or paste a token");
    expect(page).not.toContain("A token for GitHub, Forgejo or Gitea");
    // The button comes before the token form, which is not open.
    expect(page.indexOf("data-parent-signin")).toBeLessThan(page.indexOf("Or paste a token"));
  });

  test("a cell's child is offered only what its cell can reach", async () => {
    const { offersFor } = await import("../src/spawn/origin_broker.ts");
    const ledger = join(parent.config.dataDir, "spawn", "maria.json");
    const before = await readFile(ledger, "utf8");
    try {
      await writeFile(ledger, JSON.stringify({ ...JSON.parse(before), placement: "cell" }));
      // Beside the parent's own name (a sibling), or one of the public git hosts: reachable. Elsewhere: not.
      penv.FORGE_ORIGIN_CLIENT_ID = "forge.test=a,git.elsewhere.example=b,codeberg.org=c";
      const hosts = (await offersFor(parent, "maria", penv)).map((o) => o.host);
      expect(hosts).toEqual(["forge.test", "codeberg.org"]);
      // On a platform host with room beside it, a sibling's name is reachable by the wildcard.
      const reach = childOriginHosts(parent.db, "https://forge.open-platform.sh");
      expect(hostAllowed(reach, "git.open-platform.sh", 443)).toBe(true);
      expect(hostAllowed(reach, "git.open-platform.sh", 22)).toBe(false);
      expect(hostAllowed(reach, "git.elsewhere.example", 443)).toBe(false);
    } finally {
      await writeFile(ledger, before);
      penv.FORGE_ORIGIN_CLIENT_ID = `localhost=${CLIENT_ID}`;
    }
  });
});

describe("the code flow, through the parent", () => {
  test("a person signs in at the provider and the child ends with the token and nothing else", async () => {
    fresh(maria);
    setLogLevel("debug");
    const spy = (["log", "info", "warn", "error"] as const).map((m) => spyOn(console, m).mockImplementation(() => undefined));
    try {
      const s = await click(maria, "ana");
      expect(s.start.origin).toBe(parentServers.url);
      expect(s.start.pathname).toBe(BROKER_START);
      expect(s.start.searchParams.get("child")).toBe("maria");
      expect(s.start.searchParams.get("path")).toBe(BROKER_CALLBACK);

      // The child kept the state only as a digest, and the verifier sealed.
      const row = JSON.stringify(maria.app.db.query("SELECT * FROM oauth_flow WHERE id = ?1").get(s.flowId));
      expect(row).not.toContain(s.state);
      const secrets = flowSecrets(maria.app.db, maria.app.config.dataDir, s.flowId)!;
      expect(row).not.toContain(secrets.verifier);

      // A return address in the request is not taken: the parent derives it from the child's name.
      const yes = await sayYes(s, "return=https://evil.test/steal&redirect_uri=https://evil.test", "http");
      // The parent ran the authorize with its own state, challenge and registered callback.
      expect(yes.authorize.origin).toBe(code.fake.url);
      expect(yes.authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(yes.authorize.searchParams.get("redirect_uri")).toBe(`${parentServers.url}/settings/origins/callback`);
      expect(yes.authorize.searchParams.get("state")).not.toBe(s.state);
      expect(yes.authorize.searchParams.get("code_challenge")).not.toBe(s.challenge);
      expect(yes.authorize.searchParams.get("scope")).toContain("read:repository");
      expect(yes.cookie).toStartWith("forge_broker=");

      expect(yes.back.status).toBe(303);
      const back = new URL(yes.back.headers.get("location")!);
      expect(back.origin).toBe(childPublicUrl("maria", PARENT_URL));
      expect(back.origin).toBe("https://maria--forge.test");
      expect(back.pathname).toBe(BROKER_CALLBACK);
      expect([...back.searchParams.keys()].sort()).toEqual(["code", "state"]);
      expect(back.searchParams.get("state")).toBe(s.state);
      const oneTime = back.searchParams.get("code")!;
      expect(oneTime).not.toBe(code.oauth.authCode);
      expect(yes.back.headers.get("referrer-policy")).toBe("no-referrer");

      // The parent holds the token sealed, for no more than a minute, and as one row.
      const held = brokerRows();
      expect(held).toHaveLength(1);
      expect(JSON.stringify(held)).not.toContain(code.oauth.accessToken);
      expect(JSON.stringify(held)).not.toContain(oneTime);
      expect(Date.parse(held[0]!["expires_at"] as string) - Date.now()).toBeLessThanOrEqual(CODE_TTL_MS);

      // The child verifies its state, redeems server to server, and connects through the one function.
      const landed = await arrive(maria, back, "ana");
      expect(landed.status).toBe(303);
      expect(landed.headers.get("location")).toBe("/settings/origins?connected=1");
      const origin = maria.app.db.query<{ id: string }, []>("SELECT id FROM origin").get()!;
      const connected = getOriginById(maria.app.db, origin.id)!;
      expect(connected).toMatchObject({ authKind: "oauth", login: LOGIN });
      const stored = open(maria.app.config.dataDir, sealedSecrets(maria.app.db, origin.id)!.token, origin.id);
      expect(stored).toEqual({ ok: true, value: code.oauth.accessToken });
      expect(getCursor(maria.app.db, origin.id, VIA_PARENT)).toBe("1");
      expect(callsMade.map((c) => c.op)).toContain("redeem");

      // The token is gone from the parent, and its row too by the next prune.
      expect(JSON.stringify(brokerRows())).not.toContain(code.oauth.accessToken);
      expect(brokerRows().every((r) => r["token_enc"] === "")).toBe(true);

      // Audit: who, where, which account. Never the token or the code.
      const events = JSON.stringify([...listEvents(parent.db, { limit: 200 }), ...listEvents(maria.app.db, { limit: 200 })]);
      expect(events).toContain("origin.brokered");
      expect(events).toContain('"child":"maria"');
      expect(events).toContain(LOGIN);
      for (const secret of [code.oauth.accessToken, code.oauth.refreshToken, oneTime, code.oauth.authCode, secrets.verifier])
        expect(events).not.toContain(secret);

      // Nor in a log line, at debug.
      const lines = spy.flatMap((s) => s.mock.calls.map((c) => c.join(" "))).join("\n");
      for (const secret of [code.oauth.accessToken, code.oauth.refreshToken, oneTime, code.oauth.authCode, secrets.verifier])
        expect(lines).not.toContain(secret);
    } finally {
      for (const s of spy) s.mockRestore();
      setLogLevel(level);
    }
  });

  test("a state that is not this person's, unspent, or made up is refused and spends nothing", async () => {
    fresh(maria);
    const s = await click(maria, "ana");
    const yes = await sayYes(s);
    const back = new URL(yes.back.headers.get("location")!);
    const asked = callsMade.length;

    // Made up.
    const invented = new URL(back);
    invented.searchParams.set("state", "made-up-state");
    expect((await arrive(maria, invented, "ana")).headers.get("location")).toBe("/settings/origins?error=state");
    // Another person on this forge, with the real state and code (a login CSRF carried to a victim).
    expect((await arrive(maria, back, "bob")).headers.get("location")).toBe("/settings/origins?error=state");
    // Signed out: nothing is carried through the sign-in page.
    const signedOut = await realFetch(`${maria.servers.url}${back.pathname}${back.search}`, { redirect: "manual" });
    expect(signedOut.headers.get("location")).toBe("/settings/origins");
    // None of those asked the parent for anything; the code is still good.
    expect(callsMade.length).toBe(asked);
    expect(brokerRows().filter((r) => r["status"] === "ready")).toHaveLength(1);

    // The rightful person finishes, once.
    expect((await arrive(maria, back, "ana")).headers.get("location")).toBe("/settings/origins?connected=1");
    expect((await arrive(maria, back, "ana")).headers.get("location")).toBe("/settings/origins?error=state");
  });

  test("a code is redeemed once, by its own child, with its own verifier, inside a minute", async () => {
    fresh(maria);
    const s = await click(maria, "ana");
    const back = new URL((await sayYes(s)).back.headers.get("location")!);
    const oneTime = back.searchParams.get("code")!;
    const verifier = flowSecrets(maria.app.db, maria.app.config.dataDir, s.flowId)!.verifier;

    // Another child, presenting the code with the right verifier, finds nothing, and does not spend it.
    expect((await callParent(otto.app, "redeem", { code: oneTime, verifier })).ok).toBe(false);
    expect(brokerRows().filter((r) => r["status"] === "ready")).toHaveLength(1);
    // The right child with the wrong verifier gets nothing, and the code is spent.
    const wrong = await callParent(maria.app, "redeem", { code: oneTime, verifier: "v".repeat(60) });
    expect(wrong).toEqual({ ok: false, error: { error: "invalid_code" } });
    const spentNow = await callParent(maria.app, "redeem", { code: oneTime, verifier });
    expect(spentNow.ok).toBe(false);
    // The browser arriving with a spent code ends the flow without a connection.
    const landed = await arrive(maria, back, "ana");
    expect(landed.headers.get("location")).toContain("/settings/origins?error=");
    expect(maria.app.db.query("SELECT id FROM origin").all()).toHaveLength(0);
  });

  test("a code that waited past its minute is dead, and a replay of a good one is too", async () => {
    fresh(maria);
    const s = await click(maria, "ana");
    const back = new URL((await sayYes(s)).back.headers.get("location")!);
    parent.db.query("UPDATE origin_broker SET expires_at = ?1").run(new Date(Date.now() - 1000).toISOString());
    const late = await arrive(maria, back, "ana");
    expect(late.headers.get("location")).toContain("error=");
    expect(maria.app.db.query("SELECT id FROM origin").all()).toHaveLength(0);

    fresh(maria);
    const s2 = await click(maria, "ana");
    const back2 = new URL((await sayYes(s2)).back.headers.get("location")!);
    const verifier = flowSecrets(maria.app.db, maria.app.config.dataDir, s2.flowId)!.verifier;
    expect((await arrive(maria, back2, "ana")).headers.get("location")).toBe("/settings/origins?connected=1");
    expect((await callParent(maria.app, "redeem", { code: back2.searchParams.get("code")!, verifier })).ok).toBe(false);
  });

  test("the browser that finishes must be the one that began: a callback without its cookie yields no code", async () => {
    fresh(maria);
    const s = await click(maria, "ana");
    const go = await brokerStart(parentCtx(s.start), `${parentServers.url}/settings/origins/callback`, deps());
    const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
    const asked = code.oauth.tokenRequests.length;
    const back = await realFetch(
      `${parentServers.url}/settings/origins/callback?state=${encodeURIComponent(state)}&code=${code.oauth.authCode}`,
      { redirect: "manual" },
    );
    const to = new URL(back.headers.get("location")!);
    expect(to.origin).toBe("https://maria--forge.test");
    expect(to.searchParams.get("code")).toBeNull();
    expect(to.searchParams.get("error")).toBe("browser");
    expect(code.oauth.tokenRequests.length).toBe(asked);
    expect(brokerRows()).toHaveLength(0);
    // The child shows it in words and connects nothing.
    expect((await arrive(maria, to, "ana")).headers.get("location")).toContain("error=");
    expect(maria.app.db.query("SELECT id FROM origin").all()).toHaveLength(0);
  });

  test("a person who says no at the provider comes back with no code, and the parent keeps nothing", async () => {
    fresh(maria);
    const s = await click(maria, "ana");
    const go = await brokerStart(parentCtx(s.start), `${parentServers.url}/settings/origins/callback`, deps());
    const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
    const cookie = (go.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = await realFetch(
      `${parentServers.url}/settings/origins/callback?state=${encodeURIComponent(state)}&error=access_denied`,
      { headers: { cookie }, redirect: "manual" },
    );
    const to = new URL(back.headers.get("location")!);
    expect(to.searchParams.get("error")).toBe("denied");
    expect(to.searchParams.get("code")).toBeNull();
    expect(brokerRows()).toHaveLength(0);
    const landed = await arrive(maria, to, "ana");
    expect(decodeURIComponent(landed.headers.get("location")!)).toContain("You said no");
  });

  test("the parent's operator rules apply: an administrator of the origin is refused before a code exists", async () => {
    fresh(maria);
    code.fake.state.siteAdmin = true;
    try {
      const s = await click(maria, "ana");
      const to = new URL((await sayYes(s)).back.headers.get("location")!);
      expect(to.searchParams.get("error")).toBe("refused");
      expect(to.searchParams.get("code")).toBeNull();
      expect(brokerRows()).toHaveLength(0);
      const kinds = listEvents(parent.db, { limit: 50 }).map((e) => e.kind);
      expect(kinds).toContain("origin.brokered.refused");
    } finally {
      code.fake.state.siteAdmin = false;
    }
  });
});

describe("who may start one", () => {
  const signedStart = (o: { child: string; key: string; host?: string; path?: string; at?: number; state?: string }) => {
    const parts = {
      child: o.child,
      host: o.host ?? "localhost",
      state: o.state ?? "s".repeat(32),
      challenge: "c".repeat(43),
      path: o.path ?? BROKER_CALLBACK,
      at: o.at ?? Date.now(),
    };
    const url = new URL(`${parentServers.url}${BROKER_START}`);
    url.searchParams.set("child", parts.child);
    url.searchParams.set("target", parts.host);
    url.searchParams.set("state", parts.state);
    url.searchParams.set("challenge", parts.challenge);
    url.searchParams.set("path", parts.path);
    url.searchParams.set("at", String(parts.at));
    url.searchParams.set("sig", signWith(o.key, startText(parts)));
    return url;
  };
  const refused = async (url: URL): Promise<void> => {
    const res = await brokerStart(parentCtx(url), `${parentServers.url}/settings/origins/callback`, deps());
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(brokerRows()).toHaveLength(0);
  };

  test("a name this forge did not make, another child's key, a changed field, a stale time, or another return path: nothing", async () => {
    fresh(maria);
    await refused(signedStart({ child: "nobody", key: maria.key }));
    await refused(signedStart({ child: "maria", key: otto.key }));
    await refused(signedStart({ child: "maria", key: "not-the-key" }));
    await refused(signedStart({ child: "maria", key: maria.key, at: Date.now() - 20 * 60_000 }));
    await refused(signedStart({ child: "maria", key: maria.key, path: "/anything/else" }));
    await refused(signedStart({ child: "maria", key: maria.key, path: "https://evil.test/" }));
    // Signed for one host, sent for another.
    const swapped = signedStart({ child: "maria", key: maria.key });
    swapped.searchParams.set("target", "evil.example");
    await refused(swapped);
    // A host the parent holds no application for.
    await refused(signedStart({ child: "maria", key: maria.key, host: "git.elsewhere.example" }));
    // A name that is not a name.
    await refused(signedStart({ child: "../maria", key: maria.key }));
  });

  test("a start is good once: the same child state replayed gets nothing", async () => {
    fresh(maria);
    const s = await click(maria, "ana");
    const first = await brokerStart(parentCtx(s.start), `${parentServers.url}/settings/origins/callback`, deps());
    expect(first.status).toBe(303);
    const again = await brokerStart(parentCtx(s.start), `${parentServers.url}/settings/origins/callback`, deps());
    expect(again.status).toBe(400);
    expect(brokerRows()).toHaveLength(1);
  });
});

describe("who may ask the parent", () => {
  // The interceptor answers a call in process; these go to the real route.
  const route = (body: Record<string, unknown>, key: string, sig?: string | null) => {
    const raw = JSON.stringify(body);
    return answerBrokerCall(parent, raw, sig === undefined ? signWith(key, raw) : sig, deps());
  };

  test("an unsigned, wrongly signed, stale, or unknown caller is the same 404", async () => {
    const good = { op: "offers", name: "maria", at: Date.now() };
    expect((await route(good, maria.key)).status).toBe(200);
    for (const res of [
      await route(good, maria.key, null),
      await route(good, otto.key),
      await route({ ...good, name: "nobody" }, maria.key),
      await route({ ...good, at: Date.now() - 10 * 60_000 }, maria.key),
      await route({ op: "offers" }, maria.key),
    ])
      expect(res.status).toBe(404);
    // A signature over other bytes does not carry.
    const raw = JSON.stringify(good);
    expect((await answerBrokerCall(parent, `${raw} `, signWith(maria.key, raw), deps())).status).toBe(404);
    // And over the public door, as a body of any size.
    const huge = await realFetch(`${parentServers.url}${BROKER_CALL}`, {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: signWith(maria.key, "x") },
      body: "x".repeat(20_000),
    });
    expect(huge.status).toBe(404);
  });

  test("a cell's child reaches the same door through the parent's loopback port, and nothing else gets in", async () => {
    const door = openBeatDoor(parent);
    try {
      const raw = JSON.stringify({ op: "offers", name: "otto", at: Date.now() });
      const at = `${parentLocal(door.port)}${BROKER_CALL}`;
      const signed = await realFetch(at, { method: "POST", headers: { [SIGNATURE_HEADER]: signWith(otto.key, raw) }, body: raw });
      expect(signed.status).toBe(200);
      expect(await signed.json()).toMatchObject({ ok: true });
      const forged = await realFetch(at, { method: "POST", headers: { [SIGNATURE_HEADER]: signWith(maria.key, raw) }, body: raw });
      expect(forged.status).toBe(404);
      expect((await realFetch(at, { method: "POST", body: raw })).status).toBe(404);
      // The browser's side of the broker is not on this door.
      expect((await realFetch(`${parentLocal(door.port)}${BROKER_START}`)).status).toBe(404);
    } finally {
      door.close();
    }
  });

  test("an offer lists what the parent holds, to a child that asked", async () => {
    const res = await route({ op: "offers", name: "otto", at: Date.now() }, otto.key);
    expect(await res.json()).toEqual({ ok: true, offers: [{ host: "localhost", kind: "forgejo", name: "localhost" }] });
  });
});

describe("a refresh goes through the parent, which keeps nothing", () => {
  let originId = "";
  beforeAll(async () => {
    fresh(maria);
    const s = await click(maria, "ana");
    const back = new URL((await sayYes(s)).back.headers.get("location")!);
    await arrive(maria, back, "ana");
    originId = maria.app.db.query<{ id: string }, []>("SELECT id FROM origin").get()!.id;
  });

  test("an expired token is refreshed by the parent, and the new pair is kept before it is used", async () => {
    maria.app.db.query("UPDATE origin SET expires_at = ?1 WHERE id = ?2").run(new Date(Date.now() - 1000).toISOString(), originId);
    const before = code.oauth.tokenRequests.filter((r) => r.grant_type === "refresh_token").length;
    const credential = providerForOrigin(maria.app, getOriginById(maria.app.db, originId)!);
    expect(credential.ok).toBe(true);
    if (!credential.ok) return;
    expect((await credential.value.whoami()).ok).toBe(true);
    const sent = code.oauth.tokenRequests.filter((r) => r.grant_type === "refresh_token");
    expect(sent.length - before).toBe(1);
    // The refresh used the parent's application; the child holds none.
    expect(sent.at(-1)!.client_id).toBe(CLIENT_ID);
    expect(callsMade.map((c) => c.op)).toContain("refresh");
    const sealed = sealedSecrets(maria.app.db, originId)!;
    expect(open(maria.app.config.dataDir, sealed.token, originId)).toEqual({ ok: true, value: code.oauth.accessToken });
    expect(open(maria.app.config.dataDir, sealed.refresh, originId)).toEqual({ ok: true, value: code.oauth.refreshToken });
    expect(brokerRows()).toHaveLength(0);
    const events = JSON.stringify(listEvents(parent.db, { limit: 200 }));
    expect(events).toContain("origin.brokered.refreshed");
    expect(events).not.toContain(code.oauth.refreshToken);
  });

  test("a refresh the provider refuses ends the connection on the child", async () => {
    maria.app.db.query("UPDATE origin SET expires_at = ?1 WHERE id = ?2").run(new Date(Date.now() - 1000).toISOString(), originId);
    code.oauth.refreshError = "invalid_grant";
    try {
      const credential = providerForOrigin(maria.app, getOriginById(maria.app.db, originId)!);
      if (!credential.ok) throw new Error("no credential");
      expect((await credential.value.whoami()).ok).toBe(false);
      expect(getOriginById(maria.app.db, originId)!.needsReauth).toBe(true);
    } finally {
      code.oauth.refreshError = "";
    }
  });

  test("a refresh token that did not come through the broker is the provider's to refuse, and only a child may ask", async () => {
    // The parent cannot tell where a token came from and does not need to: the provider binds a refresh
    // token to the client it was issued to, and the child can only refresh what it already holds.
    const stranger = await callParent(otto.app, "refresh", { host: "localhost", refreshToken: "ghr_not-ours-0000000000000000" });
    expect(stranger).toEqual({ ok: false, error: { error: "invalid_grant" } });
    // Asking for a host the parent holds no application for is not an oracle either.
    const elsewhere = await callParent(otto.app, "refresh", { host: "git.elsewhere.example", refreshToken: "x".repeat(30) });
    expect(elsewhere).toEqual({ ok: false, error: { error: "not_offered" } });
    const raw = JSON.stringify({ op: "refresh", name: "otto", at: Date.now(), host: "localhost", refreshToken: "x".repeat(30) });
    expect((await answerBrokerCall(parent, raw, signWith(maria.key, raw), deps())).status).toBe(404);
  });
});

describe("GitHub's device grant, begun by the parent and polled by the child", () => {
  test("the child shows the code; the token never reaches the parent", async () => {
    fresh(maria);
    current = device;
    try {
      const started = await startOAuthConnect(maria.app, asUser(maria, "bob"), { host: device.fake.url, kind: "github" });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value).toMatchObject({ flow: "device", userCode: device.oauth.userCode, brokered: true });
      expect(JSON.stringify(started.value)).not.toContain(device.oauth.deviceCode);
      const flowRow = maria.app.db.query<{ redirect_uri: string; client_id: string }, [string]>("SELECT redirect_uri, client_id FROM oauth_flow WHERE id = ?1").get(started.value.flowId)!;
      expect(flowRow.redirect_uri).toBe(BROKERED);
      expect(flowRow.client_id).toBe(CLIENT_ID);

      device.oauth.approved = true;
      const polled = await pollOAuthConnect(maria.app, asUser(maria, "bob"), started.value.flowId);
      expect(polled.ok && polled.value.status).toBe("done");
      const origin = maria.app.db.query<{ id: string }, []>("SELECT id FROM origin").get()!;
      expect(getCursor(maria.app.db, origin.id, VIA_PARENT)).toBe("1");
      expect(open(maria.app.config.dataDir, sealedSecrets(maria.app.db, origin.id)!.token, origin.id)).toEqual({ ok: true, value: device.oauth.accessToken });
      // The parent was asked once, to begin it, and holds nothing of it.
      expect(brokerRows()).toHaveLength(0);
      const parentText = JSON.stringify(listEvents(parent.db, { limit: 200 }));
      expect(parentText).not.toContain(device.oauth.accessToken);
      expect(parentText).not.toContain(device.oauth.deviceCode);
    } finally {
      current = code;
      device.oauth.approved = false;
    }
  });
});

describe("a brokered flow is not an ordinary one", () => {
  test("the ordinary callback will not take a brokered state, and the brokered one will not take an ordinary state", async () => {
    fresh(maria);
    const s = await click(maria, "carol");
    const ordinary = await realFetch(`${maria.servers.url}/settings/origins/callback?state=${encodeURIComponent(s.state)}&code=x`, {
      headers: { authorization: basic("carol") },
      redirect: "manual",
    });
    expect(ordinary.headers.get("location")).toBe("/settings/origins?error=state");
    // Its state is spent by the attempt: the flow is over, not borrowed.
    expect(await completeBrokeredCallback(maria.app, asUser(maria, "carol"), { state: s.state, code: "x" })).toEqual({ ok: false, error: "not_found" });
  });
});
