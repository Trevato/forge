/**
 * A passkey belongs to one account. A second sign-up that presents the same
 * credential id is refused, makes no account, and leaves the first alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUpWithPasskey } from "../src/actions/users.ts";
import type { Credential } from "../src/auth/webauthn.ts";
import { findPasskey, listPasskeys } from "../src/core/passkeys.ts";
import { countUsers, getUserByName } from "../src/core/users.ts";
import { PASSKEY_TAKEN } from "../src/web/passkey-words.ts";
import { serve } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { device } from "./helpers/passkey.ts";
import { fixtureSlot } from "./helpers/slot.ts";

describe("signing up with a passkey another account holds", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-passkey-taken-"));
    app = createApp({ dataDir, port: 0, passkeyOnlySignup: true });
    setLimit(app.db, "signup.per_source", 100, "setup");
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const credential: Credential = {
    id: "cred-shared-0123456789",
    alg: "ES256",
    key: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    signCount: 0,
  };
  const join_ = (username: string) =>
    signUpWithPasskey(
      app,
      { username, email: "", passkey: credential, passkeyName: "Laptop" },
      { slot: fixtureSlot(app) },
    );

  test("refused with passkey_taken, no second account, first key unchanged", async () => {
    const first = await join_("first-holder");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const users = countUsers(app.db);
    const before = findPasskey(app.db, credential.id);

    const second = await join_("second-claimant");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("passkey_taken");

    expect(getUserByName(app.db, "second-claimant")).toBeUndefined();
    expect(countUsers(app.db)).toBe(users);
    expect(listPasskeys(app.db, first.value.id)).toHaveLength(1);
    expect(findPasskey(app.db, credential.id)).toEqual(before!);
    expect(before!.userId).toBe(first.value.id);
  });

  test("the page refuses in plain words, with no cookie, and never names the holder", async () => {
    const servers = await serve(app);
    try {
      const origin = new URL(servers.url).origin;
      const d = await device(origin, new URL(servers.url).hostname);
      const post = (path: string, body: unknown) =>
        fetch(`${servers.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const signUp = async (username: string) => {
        const o = (await (await post("/signup/passkey/options", { username, email: "" })).json()) as any;
        return post("/signup/passkey", { username, email: "", challenge: o.challenge, ...(await d.create(o.challenge)) });
      };
      expect((await signUp("page-holder")).status).toBe(201);
      const users = countUsers(app.db);
      const again = await signUp("page-claimant");
      const body = await again.text();
      expect(again.status).toBe(409);
      expect(again.headers.get("set-cookie")).toBeNull();
      expect(JSON.parse(body).message).toBe(PASSKEY_TAKEN);
      expect(body).not.toContain("page-holder");
      expect(countUsers(app.db)).toBe(users);
      expect(getUserByName(app.db, "page-claimant")).toBeUndefined();
    } finally {
      await servers.stop();
    }
  });
});
