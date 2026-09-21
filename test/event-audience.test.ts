/**
 * Who an event is for. A reader of a public repository sees what happened to
 * it — never its configuration. A webhook's URL is often a secret in itself,
 * an app's variable names say what it holds, and what someone keeps on their
 * own machine is their own business. Proven on every surface that hands
 * events to a reader: the JSON outbox, the stream, and the activity rail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setAppEnvVar } from "../src/actions/apps.ts";
import { pinRepo } from "../src/actions/origins.ts";
import {
  commitToBranch,
  createRepo,
  createWebhook,
} from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { audienceFilter, eventAudience } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const HOOK = "https://hooks.example.test/services/T000/B000/s3cr3t-in-the-path";

describe("who an event is for", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let aliceToken: string;
  let bobToken: string;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-audience-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceToken = createToken(app.db, alice.id, "t", "admin").token;
    bobToken = createToken(app.db, bob.id, "t", "rw").token;
    const made = await createRepo(app, alice, {
      name: "open",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# open\n" }],
    });
    const record = insertApp(app.db, {
      repoId: repo.id,
      slug: "open",
      access: "public",
    });
    if (!record.ok) throw new Error(record.error);
    // Configuration, and one person's own choice.
    const hook = createWebhook(app, alice, repo, { url: HOOK });
    if (!hook.ok) throw new Error(String(hook.error));
    const set = await setAppEnvVar(
      app,
      alice,
      repo,
      "STRIPE_SECRET_KEY",
      "sk_live_x",
    );
    if (!set.ok) throw new Error(String(set.error));
    expect(pinRepo(app, bob, repo).ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the outbox holds all of it, and each kind has one audience", () => {
    const kinds = listEvents(app.db, { repoId: repo.id }).map((e) => e.kind);
    expect(kinds).toContain("webhook.created");
    expect(kinds).toContain("app.env_set");
    expect(kinds).toContain("repo.pinned");
    expect(kinds).toContain("push");
    expect(eventAudience("webhook.created")).toBe("admins");
    expect(eventAudience("webhook.deleted")).toBe("admins");
    expect(eventAudience("app.env_set")).toBe("admins");
    expect(eventAudience("app.env_deleted")).toBe("admins");
    expect(eventAudience("repo.settings_updated")).toBe("admins");
    expect(eventAudience("repo.pinned")).toBe("actor");
    expect(eventAudience("push")).toBe("readers");
    expect(eventAudience("a.kind.nobody.classified")).toBe("readers");
  });

  test("the filter: admins see configuration, an actor their own choice, a stranger neither", () => {
    const all = listEvents(app.db, { repoId: repo.id });
    const seenBy = (viewer: User | undefined) =>
      all.filter(audienceFilter(app.db, viewer)).map((e) => e.kind);
    const stranger = seenBy(undefined);
    expect(stranger).toContain("push");
    expect(stranger).not.toContain("webhook.created");
    expect(stranger).not.toContain("app.env_set");
    expect(stranger).not.toContain("repo.pinned");
    const bobs = seenBy(bob);
    expect(bobs).toContain("repo.pinned"); // his own
    expect(bobs).not.toContain("webhook.created");
    const alices = seenBy(alice);
    expect(alices).toContain("webhook.created");
    expect(alices).toContain("app.env_set");
    expect(alices).not.toContain("repo.pinned"); // bob's, even to an admin
  });

  test("the JSON outbox never tells a reader a webhook's URL or a variable's name", async () => {
    for (const headers of [{}, { authorization: `Bearer ${bobToken}` }]) {
      const text = await fetch(`${base}/api/v1/repos/alice/open/events`, {
        headers,
      }).then((r) => r.text());
      expect(text).toContain('"push"');
      expect(text).not.toContain("hooks.example.test");
      expect(text).not.toContain("s3cr3t");
      expect(text).not.toContain("STRIPE_SECRET_KEY");
      expect(text).not.toContain("webhook.created");
    }
    const admin = await fetch(`${base}/api/v1/repos/alice/open/events`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    }).then((r) => r.text());
    expect(admin).toContain("webhook.created");
    expect(admin).toContain("app.env_set");
  });

  test("the activity rail on the front page says nothing of it to a visitor", async () => {
    const page = await fetch(`${base}/`, {
      headers: { accept: "text/html" },
    }).then((r) => r.text());
    expect(page).not.toContain("hooks.example.test");
    expect(page).not.toContain("STRIPE_SECRET_KEY");
  });

  test("the streams hold configuration back from a reader as it happens", async () => {
    const read = async (path: string, headers: Record<string, string>) => {
      const controller = new AbortController();
      const res = await fetch(`${base}${path}`, {
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      let text = "";
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
          }
        } catch {
          // aborted
        }
      })();
      // Connected: now something for everyone, and something for admins.
      await Bun.sleep(150);
      await commitToBranch(app, alice, repo, {
        message: "more",
        files: [{ path: `f-${Date.now()}.txt`, content: "x\n" }],
      });
      const hook = createWebhook(app, alice, repo, { url: `${HOOK}-live` });
      if (!hook.ok) throw new Error(String(hook.error));
      await Bun.sleep(300);
      controller.abort();
      await pump;
      return text;
    };
    for (const path of ["/alice/open/stream", "/events"]) {
      const stranger = await read(path, {});
      expect(stranger).toContain("push");
      expect(stranger).not.toContain("hooks.example.test");
      const admin = await read(path, { authorization: `Bearer ${aliceToken}` });
      expect(admin).toContain("hooks.example.test");
    }
  }, 20_000);
});
