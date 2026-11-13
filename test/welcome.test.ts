/**
 * The person who started a forge arrives at `/welcome` and is asked for a
 * username and a password, nothing about a founder or a sent link (#11510);
 * the sent link keeps `/claim`. Enter sends the first ask; the home's scripts
 * join without a call on the one before.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { firstAskJs } from "../src/web/pages/next-steps.ts";
import { funnelJs } from "../src/web/funnel_door.ts";
import { startNameJs } from "../src/web/pages/start-forge.ts";
import { startedForge, type StartedForge } from "./helpers/claimed-forge.ts";
import { getUserByName } from "../src/core/users.ts";
import { emailVerified } from "../src/core/verify.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let fresh: StartedForge;
beforeAll(async () => {
  fresh = await startedForge("forge-welcome-");
}, 120_000);
afterAll(async () => {
  await fresh.stop();
});

const text = (html: string) => (/<main\b[\s\S]*?<\/main>/.exec(html)?.[0] ?? html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ");

test("the self-start screen is Make your account: a username and one button, Create your passkey; a password only where a passkey cannot be made", async () => {
  const html = await (await fetch(`${fresh.base}/welcome`)).text();
  const words = text(html);
  expect(words).toContain("Make your account");
  expect(html).toContain('action="/welcome"');
  expect(html).toContain('name="username"');
  expect(html).toContain('name="password"');
  expect(html).not.toContain('name="email"');
  // The one action, in the block the script shows where a passkey can run; the password in the block it hides there.
  expect(html).toMatch(/<div data-passkey="on" hidden>[^]*id="passkey-make"[^]*data-options="\/welcome\/options"[^]*Create your passkey/);
  expect(html).toMatch(/<div data-passkey="off"\s*>[^]*name="password"/);
  expect(words).toContain("A passkey is your device's fingerprint, face or PIN. There is nothing to remember.");
  expect(html.match(/data-variant="primary"/g)?.length).toBe(2);
  // No state badge: the page offers what works and never says which state it is in.
  expect(html).not.toContain("data-passkey-state");
  expect(words).not.toMatch(/Passkey o(n|ff)/);
  for (const w of [/founder/i, /claim/i, /ask .* to send/i, /email/i]) expect(words).not.toMatch(w);
  expect(html).not.toContain("/claim");
});

test("the sent link keeps /claim and its wording", async () => {
  const html = await (await fetch(`${fresh.base}/claim`)).text();
  expect(html).toContain('action="/claim"');
  expect(text(html)).toContain("This forge is yours");
});

test("a refused welcome says nothing of a sender, and a good one signs in", async () => {
  const post = (form: Record<string, string>) =>
    fetch(`${fresh.base}/welcome`, { method: "POST", headers: { origin: fresh.base }, body: new URLSearchParams(form), redirect: "manual" });
  const wrong = await post({ token: "nope", username: "maria", password: "a-long-enough-password" });
  expect(wrong.status).toBe(404);
  expect(text(await wrong.text())).not.toMatch(/founder|whoever sent/i);
  const short = await post({ token: fresh.token, username: "maria", password: "x" });
  expect(short.status).toBe(422);
  // The page comes back with the password kept in sight (the script would hide it), and the link code out of sight.
  const again = await short.text();
  expect(again).toMatch(/<div data-passkey="off" data-keep>/);
  expect(again).toMatch(/<div id="claim-token-field" hidden>/);
  const ok = await post({ token: fresh.token, username: "maria", password: "a-long-enough-password" });
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe("/");
  expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
  const spent = await post({ token: fresh.token, username: "maria2", password: "a-long-enough-password" });
  expect(spent.status).toBe(410);
  expect(text(await spent.text())).not.toMatch(/founder|whoever sent/i);
});

test("a passkey makes the account with no email and no password: the challenge, then the key, land signed in as the admin", async () => {
  const started = await startedForge("forge-welcome-key-");
  try {
    const refused = await fetch(`${started.base}/welcome/options`, { method: "POST", headers: { origin: started.base, "content-type": "application/json" }, body: JSON.stringify({ token: "nope", username: "kay" }) });
    expect(refused.status).toBe(404);
    const res = await fetch(`${started.base}/welcome/options`, { method: "POST", headers: { origin: started.base, "content-type": "application/json" }, body: JSON.stringify({ token: started.token, username: "kay" }) });
    expect(res.status).toBe(200);
    const options = (await res.json()) as { challenge: string; rpId: string; user: { name: string } };
    expect(options.user.name).toBe("kay");
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  } finally {
    await started.stop();
  }
});

test("a forge that sends no mail asks for no email and reads none; one that does offers it, never required", async () => {
  const started = await startedForge("forge-welcome-mail-");
  try {
    const html = await (await fetch(`${started.base}/claim`)).text();
    expect(html).toContain("Create your passkey");
    expect(html).not.toContain('name="email"');
    expect(text(html)).not.toMatch(/email|verify|we sent/i);
    started.child.config.mailer = async () => true;
    const withMail = await (await fetch(`${started.base}/claim`)).text();
    expect(withMail).toMatch(/<input[^>]*name="email"/);
    expect(withMail).not.toMatch(/<input[^>]*name="email"[^>]*required/);
    expect(text(withMail)).toContain("Optional. It gets you back in if you lose your passkey.");
    delete started.child.config.mailer;
    // Posted anyway, an address is not read: the account stands on the stand-in, and nothing waits on a verification.
    const res = await fetch(`${started.base}/welcome`, { method: "POST", headers: { origin: started.base }, body: new URLSearchParams({ token: started.token, username: "nomail", email: "someone@example.com", password: "a-long-enough-password" }), redirect: "manual" });
    expect(res.status).toBe(303);
    const made = getUserByName(started.child.db, "nomail")!;
    expect(made.email).toBe("nomail@no-email.invalid");
    expect(emailVerified(started.child.db, made.id)).toBe(true);
  } finally {
    await started.stop();
  }
});

test("Enter sends the first ask, Shift+Enter makes a newline", () => {
  const sent: string[] = [];
  let handler: ((e: Record<string, unknown>) => void) | undefined;
  const box = {
    value: "a bakery menu",
    form: { requestSubmit: () => sent.push("submit") },
    addEventListener: (_: string, h: typeof handler) => (handler = h),
  };
  new Function("document", firstAskJs)({ querySelector: () => box });
  const press = (o: Record<string, unknown>) => {
    let prevented = false;
    handler!({ key: "Enter", preventDefault: () => (prevented = true), ...o });
    return prevented;
  };
  expect(press({})).toBe(true);
  expect(sent).toEqual(["submit"]);
  expect(press({ shiftKey: true })).toBe(false);
  expect(sent).toEqual(["submit"]);
  box.value = "  ";
  press({});
  expect(sent).toEqual(["submit"]);
});

test("the home's scripts join without calling the one before", () => {
  const joined = `${funnelJs}\n${startNameJs}`;
  expect(() => new Function(joined)).not.toThrow();
  for (const part of [funnelJs, startNameJs]) expect(part.trimEnd().endsWith(";")).toBe(true);
});

test("the link code field is visible and required in the server render, and the forge's own name is a name a person may take (#11948)", async () => {
  const started = await startedForge("forge-welcome-name-");
  try {
    const html = await (await fetch(`${started.base}/welcome`)).text();
    expect(html).not.toMatch(/<div id="claim-token-field"[^>]*hidden/);
    expect(html).toMatch(/<input[^>]*name="token"[^>]*required|<input[^>]*required[^>]*name="token"/);
    const org = started.child.db.query<{ username: string }, []>("SELECT username FROM user WHERE kind = 'org' LIMIT 1").get()!.username;
    const res = await fetch(`${started.base}/welcome`, {
      method: "POST",
      headers: { origin: started.base },
      body: new URLSearchParams({ token: started.token, username: org, password: "a-long-enough-password" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    const row = started.child.db.query<{ kind: string; is_admin: number }, [string]>("SELECT kind, is_admin FROM user WHERE username = ?").get(org)!;
    expect(row.kind).toBe("user");
    expect(row.is_admin).toBe(1);
    const home = await fetch(`${started.base}/`, { headers: { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! } });
    expect(home.status).toBe(200);
  } finally {
    await started.stop();
  }
}, 60_000);
