/**
 * Signup and Turnstile: with no secret signup is as it was; with one, a
 * missing or bad token is refused before any account row exists. The
 * verifier is injected, so no test touches the network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { turnstileVerifier } from "../src/core/turnstile.ts";
import { settleApp } from "./helpers/tui.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

const dirs: string[] = [];
const running: { app: App; servers: Servers }[] = [];

async function boot(
  extra: Partial<Parameters<typeof createApp>[0]> = {},
): Promise<{ app: App; base: string; asked: string[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-turnstile-"));
  dirs.push(dataDir);
  const asked: string[] = [];
  const app = createApp({
    dataDir,
    port: 0,
    ...extra,
    ...(extra.turnstileSecret === undefined
      ? {}
      : {
          verifyHuman: async (token: string) => {
            asked.push(token);
            return token === "good";
          },
        }),
  });
  const servers = await serve(app);
  running.push({ app, servers });
  return { app, base: `http://localhost:${servers.port}`, asked };
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.servers.stop();
    r.app.close();
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const users = (app: App) =>
  app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user").get()!.n;

const signup = (base: string, token?: string) =>
  fetch(`${base}/api/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "casey",
      email: "casey@example.com",
      password: "correct horse battery",
      ...(token === undefined ? {} : { turnstile_token: token }),
    }),
  });

describe("turnstile signup", () => {
  test("off: signup works and nobody is asked", async () => {
    const { app, base, asked } = await boot();
    expect((await signup(base)).status).toBe(201);
    expect(users(app)).toBe(1);
    expect(asked).toEqual([]);
  });

  test("a good token makes the account", async () => {
    const { app, base, asked } = await boot({ turnstileSecret: "s" });
    expect((await signup(base, "good")).status).toBe(201);
    expect(users(app)).toBe(1);
    expect(asked).toEqual(["good"]);
  });

  test("no token or a bad one is refused with a sentence and no account", async () => {
    const { app, base } = await boot({ turnstileSecret: "s" });
    for (const token of [undefined, "", "bad"]) {
      const response = await signup(base, token);
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("human_check");
      expect(body.message).toContain("person");
    }
    expect(users(app)).toBe(0);
  });

  test("the form posts the widget's field; a bad one shows the sentence", async () => {
    const { app, base } = await boot({ turnstileSecret: "s" });
    const post = (token: string) =>
      fetch(`${base}/signup`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: base,
        },
        body: new URLSearchParams({
          username: "casey",
          email: "casey@example.com",
          password: "correct horse battery",
          "cf-turnstile-response": token,
        }),
      });
    const refused = await post("bad");
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("could not tell you are a person");
    expect(users(app)).toBe(0);
    expect((await post("good")).status).toBe(303);
    expect(users(app)).toBe(1);
  });
});

describe("turnstileVerifier", () => {
  const answer = (body: unknown, status = 200) =>
    (async (_url: unknown, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const seen: string[] = [];

  test("posts the secret and token; success true is a yes", async () => {
    const verify = turnstileVerifier("sekrit", answer({ success: true }));
    expect(await verify("tok", "203.0.113.9")).toBe(true);
    const sent = new URLSearchParams(seen.at(-1));
    expect(sent.get("secret")).toBe("sekrit");
    expect(sent.get("response")).toBe("tok");
    expect(sent.get("remoteip")).toBe("203.0.113.9");
  });

  test("everything else is a no", async () => {
    expect(await turnstileVerifier("s", answer({ success: false }))("t")).toBe(false);
    expect(await turnstileVerifier("s", answer({}, 500))("t")).toBe(false);
    expect(await turnstileVerifier("s", answer({ success: "yes" }))("t")).toBe(false);
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await turnstileVerifier("s", down)("t")).toBe(false);
    expect(await turnstileVerifier("s", answer({ success: true }))("")).toBe(false);
  });
});

describe("turnstile doors", () => {
  test("with a site key the signup page shows the widget and allows Cloudflare", async () => {
    const { base } = await boot({ turnstileSecret: "s", turnstileSiteKey: "0xSITE" });
    const response = await fetch(`${base}/signup`);
    const csp = response.headers.get("content-security-policy") ?? "";
    const text = await response.text();
    expect(text).toContain('data-sitekey="0xSITE"');
    expect(text).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    for (const directive of ["script-src", "frame-src", "connect-src"])
      expect(csp).toMatch(new RegExp(`${directive}[^;]*https://challenges.cloudflare.com`));
  });

  test("only /signup widens the policy, and the secret reaches no page", async () => {
    const { base } = await boot({ turnstileSecret: "SECRET-VALUE", turnstileSiteKey: "0xSITE" });
    for (const path of ["/", "/login", "/explore"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.headers.get("content-security-policy")).not.toContain("cloudflare");
      expect(await response.text()).not.toContain("SECRET-VALUE");
    }
    expect(await (await fetch(`${base}/signup`)).text()).not.toContain("SECRET-VALUE");
  });

  test("the admin settings line says on when Turnstile is on, and never the secret", async () => {
    const { app, base } = await boot({ turnstileSecret: "SECRET-VALUE", turnstileSiteKey: "0xSITE" });
    const admin = await seedAdmin(app, { username: "casey", email: "casey@example.com", password: "correct horse battery" });
    expect(admin.ok).toBe(true);
    const signedIn = await fetch(`${base}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ username: "casey", password: "correct horse battery" }),
    });
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await fetch(`${base}/settings/secrets`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Signup asks Cloudflare Turnstile");
    expect(text).not.toContain("Signup has no human check");
    expect(text).not.toContain("SECRET-VALUE");
  });

  test("off, the page has no widget and the policy is unchanged", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/signup`);
    expect(await response.text()).not.toContain("cf-turnstile");
    expect(response.headers.get("content-security-policy")).not.toContain("cloudflare");
  });

  async function terminalSignup(app: App, name: string): Promise<string> {
    const terminal = headlessTerminal(120, 32);
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:x" },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = (k: string, ctrl = false) =>
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    const type = async (t: string) => {
      for (const ch of t) key(ch);
      await settleApp(tui);
    };
    await settleApp(tui);
    if (!tui.screen.toText().includes("Guest ›")) {
      key("s");
      await settleApp(tui);
    }
    if (tui.screen.toText().includes("Guest › Sign in")) {
      key("t", true);
      await settleApp(tui);
    }
    await type(name);
    key("tab");
    await type(`${name}@example.com`);
    key("tab");
    await type("correct horse battery");
    key("enter");
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop();
    return text;
  }

  test("the terminal is asked for a fresh forge's first account too, and refused without a token", async () => {
    const { app, asked } = await boot({ turnstileSecret: "s" });
    const text = await terminalSignup(app, "casey");
    expect(users(app)).toBe(0);
    expect(asked).toEqual([""]);
    expect(text).toContain("sign up on the web page");
  });

  test("once an account exists the terminal cannot create another", async () => {
    const { app } = await boot({ turnstileSecret: "s" });
    expect((await seedAdmin(app, { username: "casey", email: "casey@example.com" })).ok).toBe(true);
    const text = await terminalSignup(app, "robin");
    expect(users(app)).toBe(1);
    expect(text).toContain("sign up on the web page");
  });
});
