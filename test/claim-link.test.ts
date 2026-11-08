/**
 * The claim link, round two (#729, #730). The secret travels in the URL's
 * fragment — `https://child/claim#<token>` — so no server, edge or proxy
 * on the way sees it in a request line or a Referer: the page reads it in
 * the browser and posts it in the body. Any site admin of the parent can
 * re-issue a link for a child nobody has claimed; the old one dies at once.
 * Through MCP the link stays out of the agent's conversation unless asked
 * for there on purpose (#839). The account a link makes has a password or a passkey (#2924).
 */

import { insideHiddenDiv } from "./helpers/hidden.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { verifyRegistration } from "../src/auth/webauthn.ts";
import { addPasskey, listPasskeys } from "../src/core/passkeys.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";
import { device, passkeyFields } from "./helpers/passkey.ts";
import { withScripts } from "./helpers/page-script.ts";

quietLogs();

const PASSWORD = "a-long-claim-passphrase";

describe("the claim link in the fragment, and its re-issue", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let childServers: Servers;
  let adminRw = "";
  let adminRo = "";
  let bobRw = "";
  let first = "";
  let second = "";
  let kaiBody = "";

  const reissue = (token: string, name = "maria", origin?: string) =>
    fetch(`${parentServers.url}/api/v1/forges/${name}/claim-link`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin ? { origin } : {}),
      },
    });
  const claim = (form: Record<string, string>, path = "/claim") =>
    fetch(`${childServers.url}${path}`, {
      method: "POST",
      headers: { origin: childServers.url },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  /** What the page does: a passkey from `/claim/options`, then the form. */
  const claimWithKey = async (form: Record<string, string>) =>
    claim({ ...form, ...(await passkeyFields(childServers.url, "/claim/options", form)) });
  const tokenOf = (url: string) => url.split("#")[1] ?? "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-claim-link-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    const bob = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "b@x.test",
      password: PASSWORD,
    });
    if (!alice.ok || !bob.ok) throw new Error("users");
    adminRw = createToken(parent.db, alice.value.id, "rw", "rw").token;
    adminRo = createToken(parent.db, alice.value.id, "ro", "ro").token;
    bobRw = createToken(parent.db, bob.value.id, "rw", "rw").token;
    const repo = await createRepo(parent, alice.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    parentServers = await serve(parent);
    const made = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminRw}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "maria",
        apps: ["alice/bakery"],
        dryRun: false,
      }),
    });
    if (made.status !== 201)
      throw new Error(`spawn ${made.status} ${await made.text()}`);
    const body = (await made.json()) as { claimUrl: string; bodyId: string };
    first = body.claimUrl;
    child = createApp({ dataDir: childDirOf(parent, body.bodyId), port: 0 });
    await firstBoot(child);
    childServers = await serve(child);
  }, 60_000);

  afterAll(async () => {
    childServers.stop();
    child.close();
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the link carries its secret in the fragment, never in the path or a query", () => {
    expect(first).toMatch(
      /^https:\/\/maria--forge\.test\/claim#[A-Za-z0-9_-]{43}$/,
    );
  });

  test("the claim page itself is fetched with no secret, and holds none", async () => {
    const page = await fetch(`${childServers.url}/claim`);
    expect(page.status).toBe(200);
    const html = await withScripts(childServers.url, await page.text());
    expect(html).not.toContain(tokenOf(first));
    // The page takes the fragment in the browser and drops it from the address.
    expect(html).toContain("location.hash");
    expect(html).toContain("replaceState");
    expect(html).toContain('name="token"');
  });

  test("the claim page and its dead-link state are not boxed in cards", async () => {
    const html = await (await fetch(`${childServers.url}/claim`)).text();
    expect(html).not.toContain('class="card');
    expect(html).toContain('id="claim-access"');
    expect(html).toMatch(/<form[^>]*action="\/claim"/);
    expect(html).toContain('class="settings-block"');
    const dead = await claim({ token: "nonsense", username: "x" });
    expect(dead.status).toBe(404);
    expect(await dead.text()).not.toContain('class="card');
  });

  test("the claim page draws the passkey state as a badge, not a passkey-on class", async () => {
    const html = await (await fetch(`${childServers.url}/claim`)).text();
    expect(html).toContain("Passkey off");
    expect(html).toMatch(/<span\s+class="badge"\s+data-variant="outline"\s*>\s*Passkey off/);
    expect(html).not.toContain("passkey-on");
    expect(html).not.toContain('class="passkey');
    expect(insideHiddenDiv(html, "data-passkey-state")).toBe(false);
  });

  test("an unclaimed forge's sign-in page leads to the claim page; the parent's does not", async () => {
    expect(await (await fetch(`${childServers.url}/signin`)).text()).toContain('href="/claim"');
    expect(await (await fetch(`${parentServers.url}/signin`)).text()).not.toContain('href="/claim"');
  });

  test("a token in a query string is never read: only the form's body counts", async () => {
    const res = await fetch(
      `${childServers.url}/claim?token=${tokenOf(first)}`,
      {
        method: "POST",
        headers: { origin: childServers.url },
        body: new URLSearchParams({
          username: "q",
          email: "q@x.test",
        }),
        redirect: "manual",
      },
    );
    expect(res.status).toBe(404);
    expect(getUserByName(child.db, "q")).toBeUndefined();
  });

  test("only the parent's admin, with a token that may write, re-issues a link", async () => {
    expect((await reissue(bobRw)).status).toBe(403);
    expect((await reissue(adminRo)).status).toBe(403);
    expect((await reissue(adminRw, "nobody")).status).toBe(404);
    expect(
      (await reissue(adminRw, "maria", "https://evil.test")).status,
    ).toBeLessThan(500);
  });

  test("a re-issued link works and the old one is dead at once", async () => {
    const res = await reissue(adminRw);
    expect(res.status).toBe(201);
    second = ((await res.json()) as { claimUrl: string }).claimUrl;
    expect(second).toMatch(/\/claim#[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(second)).not.toBe(tokenOf(first));
    const old = await claim({
      token: tokenOf(first),
      username: "old",
      email: "old@x.test",
    });
    expect(old.status).toBe(404);
    expect(getUserByName(child.db, "old")).toBeUndefined();
    // A reserved name is refused for what it is (#720), and the link is
    // not spent by the refusal.
    const reservedForm = { token: tokenOf(second), username: "admin", email: "admin@x.test" };
    const reservedKey = await passkeyFields(childServers.url, "/claim/options", reservedForm);
    const reserved = await claim({ ...reservedForm, ...reservedKey });
    expect(reserved.status).toBe(422);
    expect(await reserved.text()).toContain("That name is reserved.");
    expect(getUserByName(child.db, "admin")).toBeUndefined();
    // The same filled form again: its challenge answered once already.
    const replayed = await claim({ ...reservedForm, ...reservedKey });
    expect(replayed.status).toBe(422);
    expect(await replayed.text()).toContain("That request expired.");
    expect(getUserByName(child.db, "admin")).toBeUndefined();
    // A device whose key another account on this forge already holds.
    const holder = await createUser(child.db, { origin: "seed", trusted: true, username: "holder", email: "h@x.test" });
    if (!holder.ok) throw new Error(holder.error);
    const shared = await device(childServers.url);
    const held = await passkeyFields(childServers.url, "/claim/options", { token: tokenOf(second), username: "holder-two", email: "h2@x.test" }, { device: shared });
    const cred = await verifyRegistration(held, { challenge: held.challenge, origin: childServers.url, rpId: new URL(childServers.url).hostname });
    if (!cred.ok) throw new Error("registration");
    expect(addPasskey(child.db, holder.value.id, "Passkey", cred).ok).toBe(true);
    const takenForm = { token: tokenOf(second), username: "taker", email: "t@x.test" };
    const taken = await claim({
      ...takenForm,
      ...(await passkeyFields(childServers.url, "/claim/options", takenForm, { device: shared })),
    });
    expect(taken.status).toBe(422);
    const takenPage = await taken.text();
    expect(takenPage).toContain("That passkey is already registered.");
    expect(takenPage).not.toContain("passkey-note");
    expect(takenPage).toMatch(/<div class="field"><span class="error" id="passkey-make-note" data-fail="error" role="alert">That passkey is already registered\./);
    expect(getUserByName(child.db, "taker")).toBeUndefined();
    expect(listPasskeys(child.db, holder.value.id)).toHaveLength(1);
    // Still unspent: the link gives a challenge yet.
    const live = await fetch(`${childServers.url}/claim/options`, {
      method: "POST",
      headers: { origin: childServers.url, "content-type": "application/json" },
      body: JSON.stringify(takenForm),
    });
    expect(live.status).toBe(200);
    // A claim challenge, kept to try at the everyday form once signed in.
    const claimOnly = await passkeyFields(childServers.url, "/claim/options", takenForm);
    // A password too short is refused, and spends nothing.
    const weak = await claim({ token: tokenOf(second), username: "maria-owner", password: "short" });
    expect(weak.status).toBe(422);
    expect(await weak.text()).toContain("Passwords need at least 12 characters.");
    expect(getUserByName(child.db, "maria-owner")).toBeUndefined();
    // So is one past the hash cap, in words, also without spending the link.
    const long = await claim({ token: tokenOf(second), username: "maria-owner", password: "x".repeat(1025) });
    expect(long.status).toBe(422);
    expect(await long.text()).toContain("Use 1024 bytes or fewer.");
    expect(getUserByName(child.db, "maria-owner")).toBeUndefined();
    // A malformed address is refused on the password door, and so is a stand-in typed by hand.
    for (const email of ["not-an-address", "me@no-email.invalid"]) {
      const bad = await claim({ token: tokenOf(second), username: "maria-owner", email, password: PASSWORD });
      expect(bad.status).toBe(422);
      expect(await bad.text()).toContain("That does not look like an email address.");
    }
    // The passkey door needs an address: no challenge without one, and a filled form that lost it is refused.
    const noMail = await fetch(`${childServers.url}/claim/options`, {
      method: "POST",
      headers: { origin: childServers.url, "content-type": "application/json" },
      body: JSON.stringify({ token: tokenOf(second), username: "maria-owner" }),
    });
    expect(noMail.status).toBe(422);
    const keyed = { token: tokenOf(second), username: "maria-owner", email: "m@x.test" };
    const lost = await claim({ ...(await passkeyFields(childServers.url, "/claim/options", keyed)), token: keyed.token, username: keyed.username });
    expect(lost.status).toBe(422);
    expect(await lost.text()).toContain("That does not look like an email address.");
    expect(getUserByName(child.db, "maria-owner")).toBeUndefined();
    const ok = await claimWithKey({
      token: tokenOf(second),
      username: "maria-owner",
      email: "m@x.test",
    });
    expect(ok.status).toBe(303);
    const owner = getUserByName(child.db, "maria-owner")!;
    expect(owner.isAdmin).toBe(true);
    expect(listPasskeys(child.db, owner.id)).toHaveLength(1);
    expect(
      (child.db.query("SELECT password_hash AS h FROM user WHERE id = ?1").get(owner.id) as { h: string }).h,
    ).toBe("");
    // Single-use: the spent link gives no second challenge and no second account.
    const twice = await fetch(`${childServers.url}/claim/options`, {
      method: "POST",
      headers: { origin: childServers.url, "content-type": "application/json" },
      body: JSON.stringify({ token: tokenOf(second), username: "maria-two", email: "m2@x.test" }),
    });
    expect(twice.status).toBe(410);
    expect(getUserByName(child.db, "maria-two")).toBeUndefined();
    // A challenge from /claim/options is not spent at the everyday form.
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
    const crossed = await fetch(`${childServers.url}/settings/everyday`, {
      method: "POST",
      headers: { cookie, origin: childServers.url },
      body: new URLSearchParams({ username: "owner-me", email: "me@x.test", ...claimOnly }),
      redirect: "manual",
    });
    expect(crossed.status).toBe(303);
    const flash = (crossed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const home = await (await fetch(`${childServers.url}/`, { headers: { cookie: `${cookie}; ${flash}` } })).text();
    expect(home).toContain("That request expired.");
    expect(getUserByName(child.db, "owner-me")).toBeUndefined();
  });

  test("/claim/options refuses another site, and slows a stream of asks", async () => {
    const ask = (origin: string) =>
      fetch(`${childServers.url}/claim/options`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "x", username: "someone", email: "s@x.test" }),
      });
    expect((await ask("https://evil.test")).status).toBe(403);
    let res = await ask(childServers.url);
    for (let i = 0; i < 100 && res.status !== 429; i++) res = await ask(childServers.url);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("once claimed, the sign-in page no longer offers a claim", async () => {
    expect(await (await fetch(`${childServers.url}/signin`)).text()).not.toContain('href="/claim"');
  });

  test("a claimed forge's link is not re-issued", async () => {
    const res = await reissue(adminRw);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("already claimed");
  });

  test("a replay of the re-issue under one Idempotency-Key never returns the link", async () => {
    // A fresh child, so the first answer has a link to hide.
    const made = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminRw}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "kai",
        apps: ["alice/bakery"],
        dryRun: false,
      }),
    });
    expect(made.status).toBe(201);
    kaiBody = ((await made.json()) as { bodyId: string }).bodyId;
    const send = () =>
      fetch(`${parentServers.url}/api/v1/forges/kai/claim-link`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminRw}`,
          "idempotency-key": "kai-re-1",
        },
      });
    const a = (await (await send()).json()) as { claimUrl: string };
    expect(a.claimUrl).toContain("/claim#");
    const b = (await (await send()).json()) as { claimUrl: string };
    expect(b.claimUrl).not.toContain("/claim#");
  });

  test("MCP claim_link keeps the link out of the conversation unless reveal is sent (#839)", async () => {
    const call = async (token: string, args: Record<string, unknown>) => {
      const res = await fetch(`${parentServers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "claim_link", arguments: args },
        }),
      });
      const r = ((await res.json()) as any).result;
      return { error: r.isError === true, text: r.content[0].text as string };
    };
    // Without reveal nothing is re-issued and no link is in the answer.
    const kept = await call(adminRw, { name: "kai" });
    expect(kept.error).toBe(false);
    expect(kept.text).not.toContain("/claim#");
    expect(JSON.parse(kept.text)).toMatchObject({
      reissued: false,
      says: expect.stringContaining("/forges"),
    });
    // Asked for on purpose: a link, said plainly to be a live secret.
    const shown = await call(adminRw, { name: "kai", reveal: true });
    expect(shown.error).toBe(false);
    const body = JSON.parse(shown.text) as { claimUrl: string; says: string };
    expect(body.claimUrl).toMatch(/\/claim#[A-Za-z0-9_-]{43}$/);
    expect(body.says).toContain("live secret");
    // Revealing is a re-issue: a token that may only read gets nothing.
    const ro = await call(adminRo, { name: "kai", reveal: true });
    expect(ro.error).toBe(true);
    expect(ro.text).not.toContain("/claim#");
  });

  test("a username, an email and a password make the first admin, who can sign in with it", async () => {
    const kid = createApp({ dataDir: childDirOf(parent, kaiBody), port: 0 });
    await firstBoot(kid);
    const kidServers = await serve(kid);
    try {
      const reissued = await fetch(`${parentServers.url}/api/v1/forges/kai/claim-link`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminRw}` },
      });
      const token = tokenOf(((await reissued.json()) as { claimUrl: string }).claimUrl);
      const res = await fetch(`${kidServers.url}/claim`, {
        method: "POST",
        headers: { origin: kidServers.url },
        body: new URLSearchParams({ token, username: "kai-owner", email: "kai@x.test", password: PASSWORD }),
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("set-cookie") ?? "").toContain("forge_session=");
      const owner = getUserByName(kid.db, "kai-owner")!;
      expect(owner.isAdmin).toBe(true);
      expect(owner.email).toBe("kai@x.test");
      expect(await Bun.password.verify(PASSWORD, (kid.db.query("SELECT password_hash AS h FROM user WHERE id = ?1").get(owner.id) as { h: string }).h)).toBe(true);
    } finally {
      kidServers.stop();
      kid.close();
    }
  });

  test("the passkey button asks for the email in the browser, before any round trip", async () => {
    const { passkeyJs } = await import("../src/web/passkey-client.ts");
    expect(passkeyJs).toContain("data-needs-email");
  });
});
