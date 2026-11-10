/**
 * The snapshot destination: sealed settings beat the environment and the
 * page says which is in effect; one resolver serves nightly and restore;
 * a failed connection test is one sentence with no key in it; writing is
 * for admins and the keys are never shown again.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  forgetDestination,
  saveDestination,
  testDestination,
} from "../src/actions/destination.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveDestination } from "../src/snapshot/destination.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const input = {
  endpoint: "http://127.0.0.1:1",
  bucket: "my-bucket",
  region: "",
  accessKey: "AKIAEXAMPLE",
  secretKey: "s3cr3t-value-xyz",
};

describe("the snapshot destination", () => {
  let root = "";
  let app: App;
  let admin: User;
  let plain: User;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-dest-"));
    app = createApp({ dataDir: root, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    admin = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "another-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    plain = b.value;
  });
  afterAll(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Every test starts with nothing sealed and makes the destination it reads.
  beforeEach(() => {
    forgetDestination(app, admin);
  });

  const sources = () => ({
    db: app.db,
    dataDir: root,
    bus: app.bus,
  });
  const env = {
    S3_ENDPOINT: "https://env.example.com",
    S3_BUCKET: "envbucket",
    S3_ACCESS_KEY: "k",
    S3_SECRET_KEY: "s",
  };

  test("precedence: sealed over the directory over the environment", () => {
    expect(resolveDestination({ ...sources(), env: {} })).toBeUndefined();
    expect(resolveDestination({ ...sources(), env })?.source).toBe("env");
    expect(
      resolveDestination({
        ...sources(),
        env: { ...env, FORGE_SNAPSHOT_DIR: join(root, "d") },
      })?.source,
    ).toBe("dir");
    expect(saveDestination(app, admin, input).ok).toBe(true);
    const sealed = resolveDestination({
      ...sources(),
      env: { ...env, FORGE_SNAPSHOT_DIR: join(root, "d") },
    });
    expect(sealed?.source).toBe("sealed");
    expect(sealed?.store.where).toBe("127.0.0.1:1/my-bucket");
  });

  test("the service follows a saved or cleared destination without a restart", async () => {
    expect(saveDestination(app, admin, input).ok).toBe(true);
    const svc = startSnapshots(
      app,
      () => resolveDestination({ ...sources(), env })?.store,
      { version: "t", nightly: false },
    );
    try {
      expect(svc.store?.where).toBe("127.0.0.1:1/my-bucket");
      forgetDestination(app, admin);
      svc.forget();
      expect(svc.store?.where).toBe("env.example.com/envbucket");
    } finally {
      await svc.stop();
    }
  });

  test("blank fields keep what is sealed; a partial seal says what is missing", () => {
    const partial = saveDestination(app, admin, {
      ...input,
      accessKey: "",
      secretKey: "",
    });
    expect(partial.ok && partial.value).toContain(
      "access key, secret key are set",
    );
    const rest = saveDestination(app, admin, {
      endpoint: "",
      bucket: "",
      region: "",
      accessKey: input.accessKey,
      secretKey: input.secretKey,
    });
    expect(rest.ok && rest.value).toContain("the next snapshot goes there");
  });

  test("a failed test-connection is one sentence and leaks no key", async () => {
    const said = await testDestination(app, admin, input);
    expect(said.ok).toBe(true);
    const sentence = said.ok ? said.value : "";
    expect(sentence).toStartWith("Could not list 127.0.0.1:1/my-bucket: ");
    expect(sentence).not.toContain("\n");
    expect(sentence).not.toContain("  ");
    expect(sentence).toBe(sentence.trim());
    expect(sentence).not.toContain(input.secretKey);
    expect(sentence).not.toContain(input.accessKey);
  });

  test("the page says a snapshot is being taken, even before there is a first one", async () => {
    const slow: Store = {
      ...dirStore(mkdtempSync(join(tmpdir(), "forge-slow-"))),
      where: "slow",
      put: async () => {
        await Bun.sleep(150);
      },
    };
    const svc = startSnapshots(app, slow, { version: "t", nightly: false });
    const servers: Servers = await serve(app);
    try {
      const signedIn = await fetch(`${servers.url}/signin`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({
          username: "alice",
          password: "a-good-passphrase",
        }),
        redirect: "manual",
      });
      const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
      const page = async () =>
        (
          await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })
        ).text();
      expect(await page()).not.toContain("A snapshot is being taken");
      expect(await page()).not.toContain("http-equiv=\"refresh\"");
      const taking = svc.now();
      let html = "";
      // Until an object has landed: the first poll can come before any has.
      for (let i = 0; i < 100 && !/A snapshot is being taken: [1-9]\d* objects/.test(html); i++) {
        await Bun.sleep(50);
        html = await page();
      }
      expect(html).toContain("A snapshot is being taken");
      const words = html.indexOf("A snapshot is being taken");
      const paragraph = html.slice(html.lastIndexOf("<p", words), words);
      expect(paragraph).toContain('role="status"');
      expect(paragraph).toContain('aria-live="polite"');
      expect(html).toContain('data-live-src="/settings/backups/live"');
      expect(html).not.toContain("http-equiv=\"refresh\"");
      expect(html).toMatch(/[1-9]\d* objects/);
      await taking;
      expect(await page()).not.toContain("A snapshot is being taken");
    } finally {
      servers.stop();
      await svc.stop();
    }
  }, 20_000);

  test("bad input is refused and non-admins are told nothing", async () => {
    for (const bad of [
      { ...input, endpoint: "ftp://x" },
      { ...input, endpoint: "https://u:p@x.com" },
      { ...input, bucket: "A_B" },
      { ...input, secretKey: "has space" },
    ]) {
      const r = saveDestination(app, admin, bad);
      expect(r.ok).toBe(false);
    }
    const nobody = saveDestination(app, plain, input);
    expect(!nobody.ok && nobody.error).toBe("not_found");
    expect((await testDestination(app, plain, input)).ok).toBe(false);
  });

  test("the page names what is in effect and never shows a key", async () => {
    const servers: Servers = await serve(app);
    try {
      const signedIn = await fetch(`${servers.url}/signin`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({
          username: "alice",
          password: "a-good-passphrase",
        }),
        redirect: "manual",
      });
      const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
      const post = (path: string, body: Record<string, string>) =>
        fetch(`${servers.url}${path}`, {
          method: "POST",
          headers: { cookie, origin: servers.url },
          body: new URLSearchParams(body),
          redirect: "manual",
        });
      const page = async () =>
        (
          await fetch(`${servers.url}/settings/backups`, {
            headers: { cookie },
          })
        ).text();
      expect(await page()).toContain("In effect:");
      const saved = await post("/settings/backups/destination", {
        endpoint: input.endpoint,
        bucket: input.bucket,
        access_key: input.accessKey,
        secret_key: input.secretKey,
      });
      expect(saved.status).toBe(303);
      const html = await page();
      expect(html).toContain("sealed in this forge");
      expect(html).not.toContain(input.secretKey);
      expect(html).not.toContain(input.accessKey);
      const cross = await fetch(`${servers.url}/settings/backups/clear`, {
        method: "POST",
        headers: { cookie, origin: "https://evil.example" },
        redirect: "manual",
      });
      expect(cross.status).toBeGreaterThanOrEqual(400);
      await post("/settings/backups/clear", {});
      expect(await page()).not.toContain("sealed in this forge");
    } finally {
      servers.stop();
    }
  });
});
