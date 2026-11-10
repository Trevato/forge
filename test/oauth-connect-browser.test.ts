/**
 * Connecting an origin, clicked in a real browser. An HTTP client follows a
 * form's redirect wherever it points; a browser first checks the posting
 * page's `form-action` policy against it, and refuses a redirect off this
 * forge without a word on the page. So this drives headless Chromium
 * (`test/helpers/chrome.ts`): click Authorize on Settings → Connected accounts, then
 * Continue on the flow's page, and see the browser actually ask the origin
 * for its consent screen — the URL stored on the flow — with no
 * Content-Security-Policy refusal on the way.
 */

import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { registerOriginApp } from "../src/actions/origins.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { clickAndFollow } from "./helpers/chrome.ts";
import { quietLogs, withoutEnv } from "./helpers/globals.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";

quietLogs();
withoutEnv("FORGE_URL");

const CLIENT_ID = "forge-browser-client";
const chromium = findChromium();
if (chromium === undefined)
  console.log(
    "SKIPPING: no chromium on this machine (FORGE_CHROMIUM), so the connect buttons cannot be clicked",
  );

describe.skipIf(chromium === undefined)("connecting an origin in a real browser", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  const consentAsked = (since: number) =>
    fake.state.requests
      .slice(since)
      .some((r) => r.method === "GET" && r.path === "/login/oauth/authorize");
  const refusals = (errors: readonly string[]) =>
    errors.filter((e) => /content security policy|csp/i.test(e));

  beforeAll(async () => {
    const state = newFakeState("forgejo", "octo", "octo-browser-token");
    state.oauth = newFakeOAuth(CLIENT_ID);
    fake = serveFakeForge(state);
    dir = await mkdtemp(join(tmpdir(), "forge-connect-browser-"));
    app = createApp({ dataDir: dir, port: 0 });
    everyoneIsAMember(app.db);
    servers = await serve(app);
  }, 20_000);

  afterAll(async () => {
    fake.stop();
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("Settings → Connected accounts: Authorize, then Continue, reaches the consent screen", async () => {
    const made = await createUser(app.db, {
      username: "bea",
      email: "bea@forge.test",
      password: "a-long-browser-passphrase",
      origin: "seed",
      trusted: true,
    });
    if (!made.ok) throw new Error(made.error);
    const registered = await registerOriginApp(app, made.value, {
      host: fake.url,
      clientId: CLIENT_ID,
    });
    expect(registered.ok).toBe(true);
    const before = fake.state.requests.length;
    const followed = await clickAndFollow(chromium!, {
      url: `${servers.url}/settings/origins?host=${encodeURIComponent(fake.url)}`,
      cookie: { name: "forge_session", value: createSession(app.db, made.value.id).token },
      steps: [
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize').click()`,
        `[...document.querySelectorAll('a')].find((a) => a.textContent.includes('Continue to the instance')).click()`,
      ],
      until: (url) => url.startsWith(`${fake.url}/login/oauth/authorize`),
      done: () => consentAsked(before),
    });
    expect(refusals(followed.errors)).toEqual([]);
    expect(consentAsked(before)).toBe(true);
  }, 30_000);
});
