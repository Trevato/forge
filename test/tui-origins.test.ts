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
import { quietLogs } from "./helpers/globals.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import type { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { settleApp } from "./helpers/tui.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeOAuth,
} from "./fake-origin.ts";

quietLogs();

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-9f2a";
const CLIENT_ID = "Iv1.forge-tui-client";
/** What an operator sets so the forge knows its own address. */
const FORGE_URL = "https://forge.example.test";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

interface Harness {
  app: App;
  terminal: HeadlessTerminal;
  text(): string;
  press(...keys: string[]): Promise<void>;
  /** Keys with no settle between them — for "what does a double press do?". */
  burst(...keys: string[]): void;
  typeText(text: string): Promise<void>;
  settle(): Promise<void>;
  /** Pump frames until the screen says something, or give up loudly. */
  until(what: string, ms?: number): Promise<void>;
  stop(): void;
}

/** The crumb trail the loop paints: one entry per screen on the stack. */
const crumbLine = (h: Harness): string => h.text().split("\n")[1] ?? "";

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

function boot(
  forge: Forge,
  identity: TuiIdentity,
  cols = 140,
  rows = 40,
): Harness {
  const terminal = headlessTerminal(cols, rows);
  const { app } = createForgeApp(forge, identity, {
    terminal,
    exitHooks: false,
  });
  app.start();
  const settle = (): Promise<void> => settleApp(app);
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
    terminal,
    text: () => app.screen.toText(),
    async press(...keys) {
      for (const key of keys) await one(key);
    },
    burst(...keys) {
      for (const key of keys)
        app.dispatch({
          type: "key",
          key,
          ctrl: false,
          alt: false,
          shift: false,
        });
      app.frame();
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

  /** Dashboard → account → origins → connect → GitHub → the device screen. */
  const openDeviceScreen = async (h: Harness): Promise<void> => {
    await h.press("A");
    await h.until("Account");
    await h.press("o");
    await h.until("Origins");
    await h.press("c");
    await h.until("Connect an origin");
    // The token is the first row now, so GitHub is one down.
    await h.press("j", "enter");
    await h.until("Connect GitHub");
    await h.typeText(github.url);
    await h.press("enter");
    await h.until("W X Y Z - 1 2 3 4");
  };

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

    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({ name: "gadgets", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/gadgets/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "README.md", content: "# gadgets\nhello\n" }],
      }),
    });

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push(
      {
        id: 41,
        fullName: "octo/widgets",
        description: "gears and things",
        cloneUrl: `${originServers.url}/octo/widgets.git`,
        htmlUrl: `${originServers.url}/octo/widgets`,
        defaultBranch: "main",
      },
      // A second remote, so there is still something un-mirrored to press
      // `m` on after the first one has been taken.
      {
        id: 42,
        fullName: "octo/gadgets",
        description: "bits and bobs",
        cloneUrl: `${originServers.url}/octo/gadgets.git`,
        htmlUrl: `${originServers.url}/octo/gadgets`,
        defaultBranch: "main",
      },
    );
    state.files.set(
      "octo/gadgets",
      new Map([["README.md", "# gadgets\n\nbits and bobs, read live\n"]]),
    );
    state.branches.set("octo/gadgets", [
      { name: "main", sha: "2".repeat(40), protected: false },
    ]);
    // The git side of the same repository, as the API would describe it —
    // this is what a *live* browse reads, with nothing cloned anywhere.
    state.files.set(
      "octo/widgets",
      new Map([
        ["README.md", "# widgets\n\ngears and things, read live\n"],
        ["src/index.ts", "export const one = 1;\n"],
      ]),
    );
    state.branches.set("octo/widgets", [
      { name: "main", sha: "1".repeat(40), protected: false },
    ]);
    state.commits.set("octo/widgets", [
      {
        sha: "1".repeat(40),
        message: "first",
        authorName: "Mona Lisa",
        login: "mona",
        date: "2026-01-01T00:00:00.000Z",
      },
    ]);
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

      // c → the chooser. A token needs no setup anywhere, so it is the first
      // row and the one `enter` lands on; the two one-click flows come after
      // it, each saying what it needs first.
      await h.press("c");
      await h.until("Connect an origin");
      const chooser = h.text();
      expect(chooser).toContain("Personal access token — recommended");
      expect(chooser).toContain("GitHub, one click");
      expect(chooser).toContain("Forgejo / Gitea, one click");
      expect(chooser).toContain("Needs a one-time OAuth app setup");
      expect(chooser).toContain("Needs an app registration on the instance");
      expect(chooser).toContain("No setup at all");
      expect(chooser.indexOf("Personal access token")).toBeLessThan(
        chooser.indexOf("GitHub, one click"),
      );
      await h.press("enter");
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
      await h.press("j", "enter");
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

  /**
   * The reason this screen has the shape it does: over SSH the URL on screen
   * is a string you cannot click and often cannot copy. So the test asserts
   * the three ways off it — a QR made of real cells, a short link short
   * enough to type, and an OSC 52 sequence that reaches the *user's*
   * terminal rather than the server's.
   */
  test("the device screen hands the connect to a phone, and c reaches the user's clipboard", async () => {
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
    process.env.FORGE_URL = FORGE_URL;
    resetConnectLimit();
    const h = boot(forge, asAlice(), 120, 40);
    try {
      await openDeviceScreen(h);

      const text = h.text();
      const found = /https:\/\/forge\.example\.test\/go\/[0-9a-z]{10}/.exec(
        text,
      );
      expect(found).not.toBeNull();
      const short = found![0];
      // The code in it belongs to a live flow row, and to nothing else.
      const row = forge.db
        .query<
          { short_code: string },
          []
        >("SELECT short_code FROM oauth_flow WHERE status = 'pending' ORDER BY id DESC LIMIT 1")
        .get();
      expect(short.endsWith(row!.short_code)).toBe(true);

      // A QR, drawn as half blocks. The signature is the top of a finder
      // pattern: seven dark modules over a dark-light-dark row render as one
      // full block, five upper halves and one full block.
      expect(text).toContain("\u2588\u2580\u2580\u2580\u2580\u2580\u2588");
      // And the full URL is still there for anyone who wants to read it.
      expect(text).toContain(ghOauth.verificationUri);

      // `c` copies the short link through the terminal itself.
      h.terminal.takeOutput();
      await h.press("c");
      const copied = h.terminal.takeOutput();
      expect(copied).toContain(
        `\u001b]52;c;${Buffer.from(short, "utf8").toString("base64")}\u0007`,
      );
      expect(h.text()).toContain("copied");
      expect(h.text()).toContain("Apple Terminal does not");

      // `C` copies the device code instead.
      h.terminal.takeOutput();
      await h.press("C");
      expect(h.terminal.takeOutput()).toContain(
        `\u001b]52;c;${Buffer.from("WXYZ-1234", "utf8").toString("base64")}\u0007`,
      );

      // `o` cannot reach a browser from the far side of a connection. It no
      // longer says so and stops there: the URL goes to the reader's own
      // clipboard through their terminal, and the toast names the gesture
      // that opens the OSC 8 link already on screen.
      h.terminal.takeOutput();
      await h.press("o");
      expect(h.terminal.takeOutput()).toContain(
        `]52;c;${Buffer.from("https://example.invalid/device", "utf8").toString("base64")}`,
      );
      // …and the link dialog shows the address plain, mouse released, so it
      // can be selected by hand where OSC 52 is not honoured.
      expect(h.text()).toContain("Link");
      expect(h.text()).toContain("https://example.invalid/device");
      await h.press("esc");
      expect(h.text()).not.toContain("Select the address");
      await h.press("esc");
    } finally {
      delete process.env.FORGE_GITHUB_CLIENT_ID;
      delete process.env.FORGE_URL;
      h.stop();
    }
  }, 60_000);

  test("at 80x24 the QR is dropped and the short link is kept", async () => {
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
    process.env.FORGE_URL = FORGE_URL;
    resetConnectLimit();
    const h = boot(forge, asAlice(), 80, 24);
    try {
      await openDeviceScreen(h);
      const text = h.text();
      // Half a QR is not a smaller QR, so at this height there is none.
      expect(text).not.toContain("\u2588\u2580\u2580\u2580\u2580\u2580\u2588");
      expect(text).toMatch(/https:\/\/forge\.example\.test\/go\/[0-9a-z]{10}/);
      expect(text).toContain("W X Y Z - 1 2 3 4");
      // All three ways off the screen are named in the help bar.
      expect(text).toContain("copy link");
      expect(text).toContain("copy code");
      expect(text).toContain("open");
      await h.press("esc");
    } finally {
      delete process.env.FORGE_GITHUB_CLIENT_ID;
      delete process.env.FORGE_URL;
      h.stop();
    }
  }, 60_000);

  test("an unconfigured GitHub explains how to configure it, where it failed", async () => {
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    resetConnectLimit();
    const h = boot(forge, asAlice(), 80, 24);
    try {
      await h.press("A");
      await h.until("Account");
      await h.press("o");
      await h.until("Origins");
      await h.press("c");
      await h.until("Connect an origin");
      await h.press("j", "enter");
      await h.until("Connect GitHub");
      await h.typeText(github.url);
      await h.press("enter");

      await h.until("Set up GitHub");
      const text = h.text();
      expect(text).toContain("github.com/settings/developers");
      expect(text).toContain("Enable Device Flow");
      expect(text).toContain("FORGE_GITHUB_CLIENT_ID");
      expect(text).toContain("/settings/origins/callback");
      expect(text).toContain("a pasted token needs no setup");
      await h.press("esc");
    } finally {
      h.stop();
    }
  }, 60_000);

  /**
   * Origins → the picker, filtered down to one row, which is where every
   * browse and every mirror starts. The filter is what makes `enter` mean a
   * named repository rather than "whatever sorted first".
   */
  const openPicker = async (h: Harness, name = "widgets"): Promise<void> => {
    await h.press("A");
    await h.until("Account");
    await h.press("o");
    await h.until(`${ORIGIN_LOGIN} @`);
    await h.press("r");
    await h.until(`octo/${name}`);
    await h.press("/");
    await h.typeText(name);
    await h.press("enter");
  };

  /** The `?` overlay: every binding this screen has, untruncated. */
  const helpText = async (h: Harness): Promise<string> => {
    await h.press("?");
    const text = h.text();
    await h.press("esc");
    return text;
  };

  test("enter opens the repository live and downloads nothing", async () => {
    const host = new URL(fake.url).host;
    const h = boot(forge, asAlice());
    try {
      await openPicker(h);
      expect(h.text()).toContain("public");
      // The row is not mirrored yet, and enter is not going to change that.
      expect(h.text()).not.toContain("mirrored as");
      expect(h.text()).toContain("browse — nothing is downloaded");

      await h.press("enter");
      // One settle: the README is on screen, read through the origin's API.
      await h.until("gears and things, read live");
      const text = h.text();

      // The where strip: three places, and only the first one has it.
      expect(text).toContain(`● ${host}`);
      expect(text).toContain("○ workbench");
      expect(text).toContain("○ this machine");
      expect(text).toContain(
        `reading live from ${host} — read-only · m mirror into your workbench`,
      );
      expect(text).toContain("read-only");
      // The tree came from the same place.
      expect(text).toContain("src/");

      // No key that would write *here* exists — not disabled, absent — and
      // the keys that do make sense on somebody else's repository are
      // offered, forking at the origin among them.
      const help = await helpText(h);
      expect(help).toMatch(/m\s+mirror/);
      expect(help).toContain("open on origin");
      expect(help).toContain(`fork at ${host}`);
      expect(help).not.toContain("settings");
      expect(help).not.toContain("sync now");

      // Pressing them anyway names the one key that leads somewhere: a live
      // browse has no bytes of ours to change, and `W` is where the copy that
      // does live.
      await h.press("e");
      expect(h.text()).toContain("W to edit the workbench copy");
      await h.press("c");
      expect(h.text()).toContain("W to edit the workbench copy");

      // And nothing at all was created here.
      expect(getRepo(forge.db, "alice", "widgets")).toBeUndefined();
    } finally {
      h.stop();
    }
  }, 60_000);

  test("going back and re-entering costs the origin nothing", async () => {
    const h = boot(forge, asAlice());
    try {
      await openPicker(h);
      await h.press("enter");
      await h.until("gears and things, read live");
      // The workspace is the tree: opening the repository already listed it
      // and read a file out of it.
      await h.until("src/");

      // ...and from here on, everything is a cache hit. Back to the picker,
      // in again, and every read is answered from the cache: the origin
      // hears nothing.
      const mark = fake.state.requests.length;
      await h.press("esc");
      await h.until("octo/widgets");
      await h.press("enter");
      await h.until("gears and things, read live");
      await h.until("src/");
      expect(fake.state.requests.length).toBe(mark);
    } finally {
      h.stop();
    }
  }, 60_000);

  test("m mirrors with a visible checklist, and the screen becomes the local one", async () => {
    const h = boot(forge, asAlice());
    try {
      await openPicker(h);
      await h.press("enter");
      await h.until("gears and things, read live");

      // Two presses with no frame between them: the job layer dedupes the
      // work and the card dedupes itself, so there is exactly one card.
      h.burst("m", "m");
      const card = h.text();
      expect(card).toContain("Mirroring octo/widgets");
      for (const stage of [
        "creating",
        "fetching",
        "labels",
        "issues",
        "pulls",
        "comments",
      ])
        expect(card).toContain(stage);
      expect(card).toContain("esc hides this");
      expect(occurrences(crumbLine(h), "Mirroring")).toBe(1);

      // Done: the card goes, and the live screen underneath is replaced in
      // place by the same screen over the repository we now hold.
      await h.until("workbench (synced");
      // The file list is the local one now: these bytes came out of our own
      // bare repository rather than off the origin's API.
      await h.until("README.md");
      const after = h.text();
      const strip = after.split("\n")[2] ?? "";
      expect(strip).toMatch(
        /^● \S+ {2}·  ● workbench \(synced .+\) {2}·  ○ this machine/,
      );
      expect(after).not.toContain("reading live from");
      // Provenance lives on the about card (`I`) now that the repo's front
      // door is a workspace rather than a page.
      await h.press("I");
      await h.settle();
      expect(h.text()).toContain("mirrored from");
      await h.press("esc");
      await h.settle();
      expect(getRepo(forge.db, "alice", "widgets")).toBeDefined();

      // The write keys are here now, and the mirror key is gone.
      const help = await helpText(h);
      expect(help).toContain("settings");
      expect(help).toContain("fork");
      expect(help).toContain("sync now");
      expect(help).not.toMatch(/m\s+mirror\b/);

      // Including the one that matters most: you can say something.
      await h.press("i");
      await h.until("The gear slips");
      await h.press("enter");
      await h.until("The gear slips");
      expect(await helpText(h)).toContain("comment");
    } finally {
      h.stop();
    }
  }, 120_000);

  /**
   * Esc is not cancel. The job is detached from the card that started it, so
   * hiding the card leaves the mirror running and the outcome still arrives —
   * and the screen you are on is *not* yanked out from under you, because by
   * then it may not be the screen the mirror was started from.
   */
  test("esc hides the card and the mirror lands anyway", async () => {
    const h = boot(forge, asAlice());
    try {
      await openPicker(h, "gadgets");
      await h.press("enter");
      await h.until("○ workbench");

      h.burst("m");
      expect(h.text()).toContain("Mirroring octo/gadgets");
      await h.press("esc");
      expect(crumbLine(h)).not.toContain("Mirroring");
      expect(h.text()).toContain("mirroring in the background");
      // Still the live browse: a hidden card never replaces a screen.
      expect(h.text()).toContain("reading live from");

      await h.until("mirrored as alice/gadgets");
      expect(getRepo(forge.db, "alice", "gadgets")).toBeDefined();
      expect(h.text()).toContain("reading live from");
    } finally {
      h.stop();
    }
  }, 120_000);

  /**
   * The question the where-strip answers is "which of these two am I reading",
   * and `W` is the answer to "show me the other one". The dot moving is the
   * whole assertion: it is the same grammar on every repo screen, so if it
   * moves here it moves everywhere.
   */
  test("W swaps a mirror between the workbench copy and the live origin", async () => {
    const h = boot(forge, asAlice());
    try {
      // `widgets` was mirrored by the test above, so this repo has two sides.
      await h.press("/");
      await h.typeText("widgets");
      await h.press("enter");
      await h.press("enter");
      await h.until("workbench (synced");
      // Both places hold the repo, so both wear a filled dot — what says
      // which one you are *reading* is the accent, so that is what is
      // asserted. (The colour, not the glyph: that is the strip's grammar.)
      expect(h.text().split("\n")[2]).toMatch(/^● \S+ {2}·  ● workbench/);
      const workbenchAccent = h.app.screen.styleAt(0, 2).fg;
      expect(h.text()).not.toContain("reading live from");
      expect(await helpText(h)).toContain("live on");

      await h.press("W");
      await h.until("reading live from");
      // Same three places, same glyphs — and the accent has moved to the
      // first one, which is the whole of what `W` means.
      expect(h.text().split("\n")[2]).toMatch(/^● \S+ {2}·  ● workbench/);
      expect(h.app.screen.styleAt(0, 2).fg).not.toBe(workbenchAccent);
      expect(h.text()).toContain("read-only");

      // And back again, to the copy we hold.
      await h.press("W");
      await h.until("workbench (synced");
      expect(h.text()).not.toContain("reading live from");
    } finally {
      h.stop();
    }
  }, 120_000);

  test("the strip marks the third place when the repo is pinned", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.until("alice/widgets");
      await h.press("/");
      await h.typeText("widgets");
      await h.press("enter");
      await h.press("enter");
      await h.until("workbench (synced");
      expect(h.text()).toContain("○ this machine");

      await h.press("P");
      await h.until("◆ this machine");
      expect(listPins(forge.db, alice.id)).toHaveLength(1);

      // Put it back, so the pin test below still starts from nothing.
      await h.press("P");
      await h.until("○ this machine");
      expect(listPins(forge.db, alice.id)).toHaveLength(0);
    } finally {
      h.stop();
    }
  }, 60_000);

  test("the picker says which rows it already holds", async () => {
    const h = boot(forge, asAlice());
    try {
      await openPicker(h);
      expect(h.text()).toContain("● mirrored as alice/widgets");
      // A row already held is not mirrored twice.
      await h.press("m");
      expect(h.text()).toContain("already mirrored");
    } finally {
      h.stop();
    }
  }, 60_000);

  test("an imported issue wears the origin's author, and a comment goes through", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.until("alice/widgets");
      await h.press("/");
      await h.typeText("widgets");
      await h.press("enter");
      await h.press("enter");
      await h.until("workbench (synced");
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
      // More than one repo is mirrored by now, so name the one being pinned.
      await h.press("/");
      await h.typeText("widgets");
      await h.press("enter");
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
