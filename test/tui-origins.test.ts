/**
 * Origins in the terminal, driven headlessly against a real forge, a fake
 * Forgejo API, and a second real forge standing in for the git host — so the
 * mirror is a genuine clone and the write-through genuinely leaves the
 * machine.
 *
 * Every assertion is made against the cell grid the renderer produced. That
 * is the point of a headless terminal: "the code is on the screen" is a claim
 * about what a person would see, not about a variable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resetConnectLimit } from "../src/actions/origins.ts";
import { signUp } from "../src/actions/users.ts";
import { listOrigins } from "../src/core/origins.ts";
import { listPins } from "../src/core/pins.ts";
import { getRepo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import type { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeOAuth,
} from "./fake-origin.ts";

setLogLevel("error");

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-9f2a";
const CLIENT_ID = "Iv1.forge-tui-client";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

interface Harness {
  app: App;
  text(): string;
  press(...keys: string[]): Promise<void>;
  typeText(text: string): Promise<void>;
  settle(): Promise<void>;
  /** Pump frames until the screen says something, or give up loudly. */
  until(what: string, ms?: number): Promise<void>;
  stop(): void;
}

function boot(forge: Forge, identity: TuiIdentity): Harness {
  const terminal = headlessTerminal(140, 40);
  const { app } = createForgeApp(forge, identity, {
    terminal,
    exitHooks: false,
  });
  app.start();
  const settle = async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    do {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 2));
    } while (app.busy && Date.now() < deadline);
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 2));
    app.frame();
  };
  const one = async (key: string): Promise<void> => {
    app.dispatch({
      type: "key",
      key: key.startsWith("ctrl+") ? key.slice(5) : key,
      ctrl: key.startsWith("ctrl+"),
      alt: false,
      shift: false,
    });
    await settle();
  };
  return {
    app,
    text: () => app.screen.toText(),
    async press(...keys) {
      for (const key of keys) await one(key);
    },
    async typeText(text) {
      for (const ch of text)
        app.dispatch({
          type: "key",
          key: ch,
          ctrl: false,
          alt: false,
          shift: false,
        });
      await settle();
    },
    settle,
    async until(what, ms = 20_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        await settle();
        if (app.screen.toText().includes(what)) return;
        if (Date.now() > deadline)
          throw new Error(
            `never saw ${JSON.stringify(what)} on screen:\n${app.screen.toText()}`,
          );
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    stop: () => app.stop(),
  };
}

describe("origins in the terminal", () => {
  let dataDir: string;
  let originDataDir: string;
  let forge: Forge;
  let originApp: Forge;
  let originServers: Servers;
  let fake: FakeForge;
  let github: FakeForge;
  let ghOauth: FakeOAuth;
  let alice: User;

  const asAlice = (): TuiIdentity => ({
    sshUsername: "alice",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    user: alice,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tuiorigins-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-tuiupstream-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await fetch(`${originServers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: ORIGIN_LOGIN,
        email: "octo@upstream.test",
        password: ORIGIN_TOKEN,
      }),
    });
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/widgets/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "README.md", content: "# widgets\nhello\n" }],
      }),
    });

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      description: "gears and things",
      cloneUrl: `${originServers.url}/octo/widgets.git`,
      htmlUrl: `${originServers.url}/octo/widgets`,
      defaultBranch: "main",
    });
    state.labels.set("octo/widgets", [{ id: 1, name: "bug", color: "d73a4a" }]);
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 7,
        title: "The gear slips",
        body: "under load",
        user: "mona",
        labels: ["bug"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    fake = serveFakeForge(state);

    const ghState = newFakeState("github", ORIGIN_LOGIN, "unused-pat");
    ghOauth = newFakeOAuth(CLIENT_ID);
    ghState.oauth = ghOauth;
    github = serveFakeForge(ghState);

    forge = createApp({ dataDir, port: 0 });
    const created = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!created.ok) throw new Error("signup failed");
    alice = created.value;
    resetConnectLimit();
    forgetProviders(dataDir);
    delete process.env.FORGE_GITHUB_CLIENT_ID;
  });

  afterAll(async () => {
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    fake.stop();
    github.stop();
    originServers.stop();
    forge.close();
    originApp.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  }, 60_000);

  test("the origins screen is empty, then a pasted token fills it", async () => {
    const h = boot(forge, asAlice());
    try {
      // Dashboard → account → origins.
      await h.press("A");
      await h.until("Account");
      await h.press("o");
      await h.until("No origins connected");
      expect(h.text()).toContain("connect an origin");

      // c → the chooser; the token path is the third row.
      await h.press("c");
      await h.until("Connect an origin");
      expect(h.text()).toContain("device code");
      await h.press("j", "j", "enter");
      await h.until("Connect with a token");

      await h.typeText(fake.url);
      await h.press("enter");
      await h.until("personal access token");
      await h.typeText(ORIGIN_TOKEN);
      // A secret typed into a terminal is never left as plain cells.
      expect(h.text()).not.toContain(ORIGIN_TOKEN);
      expect(h.text()).toContain("•");
      await h.press("enter");

      await h.until(`${ORIGIN_LOGIN} @`);
      expect(h.text()).toContain("healthy");
      expect(h.text()).toContain("token");
      expect(listOrigins(forge.db, alice.id)).toHaveLength(1);
    } finally {
      h.stop();
    }
  }, 60_000);

  test("the device-code screen shows the code and where to type it", async () => {
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
    resetConnectLimit();
    const h = boot(forge, asAlice());
    try {
      await h.press("A");
      await h.until("Account");
      await h.press("o");
      await h.until(`${ORIGIN_LOGIN} @`);
      await h.press("c");
      await h.until("Connect an origin");
      await h.press("enter");
      await h.until("Connect GitHub");
      await h.typeText(github.url);
      await h.press("enter");

      await h.until("WXYZ-1234".split("").join(" "));
      expect(h.text()).toContain(ghOauth.verificationUri);
      expect(h.text()).toContain("waiting for you to authorize");
      // The device code is the forge's half and never reaches the screen.
      expect(h.text()).not.toContain(ghOauth.deviceCode);
      await h.press("esc");
    } finally {
      delete process.env.FORGE_GITHUB_CLIENT_ID;
      h.stop();
    }
  }, 60_000);

  test("the picker mirrors a repository, and the repo says where it came from", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.press("A");
      await h.until("Account");
      await h.press("o");
      await h.until(`${ORIGIN_LOGIN} @`);
      await h.press("r");
      await h.until("octo/widgets");
      expect(h.text()).toContain("public");

      await h.press("m");
      // Mirroring clones from the second forge and imports the issues.
      await h.until("octo/widgets @");
      expect(getRepo(forge.db, "alice", "widgets")).toBeDefined();
      expect(h.text()).toContain("mirrored from");
      expect(h.text()).toContain("fetched");
    } finally {
      h.stop();
    }
  }, 60_000);

  test("an imported issue wears the origin's author, and a comment goes through", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.until("alice/widgets");
      await h.press("enter");
      await h.until("octo/widgets @");
      await h.press("i");
      await h.until("The gear slips");
      // The upstream mark plus the login on the origin, never a local name.
      expect(h.text()).toContain("mona");

      await h.press("enter");
      await h.until("The gear slips");
      expect(h.text()).toContain("mona");

      const before = fake.state.requests.length;
      await h.press("c");
      await h.until("Comment");
      await h.typeText("from the terminal");
      await h.press("ctrl+d");
      await h.until("comment posted");

      const wrote = fake.state.requests
        .slice(before)
        .some(
          (r) =>
            r.method === "POST" &&
            r.path.endsWith("/issues/7/comments") &&
            r.body.includes("from the terminal"),
        );
      expect(wrote).toBe(true);
    } finally {
      h.stop();
    }
  }, 60_000);

  test("p pins a repository and the dashboard says it is on your machine", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.until("alice/widgets");
      expect(listPins(forge.db, alice.id)).toHaveLength(0);
      await h.press("p");
      await h.until("On your machine");
      expect(listPins(forge.db, alice.id)).toHaveLength(1);
      expect(h.text()).toContain("forge sync");
      // The marker rides the row itself, not a separate list.
      expect(h.text()).toContain("◆ alice/widgets");

      await h.press("p");
      await h.until("Organizations");
      expect(listPins(forge.db, alice.id)).toHaveLength(0);
    } finally {
      h.stop();
    }
  }, 60_000);
});
