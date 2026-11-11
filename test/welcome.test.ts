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
import { JS_FLAG_JS } from "../src/web/claim_code.ts";
import { WAITING_JS } from "../src/web/pages/forge-waiting.ts";
import { startedForge, type StartedForge } from "./helpers/claimed-forge.ts";
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

test("the self-start screen is Make your account: username, password, done", async () => {
  const html = await (await fetch(`${fresh.base}/welcome`)).text();
  const words = text(html);
  expect(words).toContain("Make your account");
  expect(html).toContain('action="/welcome"');
  expect(html).toContain('name="username"');
  expect(html).toContain('name="password"');
  expect(html).not.toContain('name="email"');
  expect(html).not.toContain("passkey");
  expect(words).toContain("Done");
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
  const ok = await post({ token: fresh.token, username: "maria", password: "a-long-enough-password" });
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe("/");
  expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
  const again = await post({ token: fresh.token, username: "maria2", password: "a-long-enough-password" });
  expect(again.status).toBe(410);
  expect(text(await again.text())).not.toMatch(/founder|whoever sent/i);
});

test("the waiting page goes to /welcome, not /claim", () => {
  expect(WAITING_JS).not.toContain("/claim");
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
  const joined = `${funnelJs}\n${startNameJs}\n${JS_FLAG_JS}`;
  expect(() => new Function(joined)).not.toThrow();
  for (const part of [funnelJs, startNameJs]) expect(part.trimEnd().endsWith(";")).toBe(true);
});
