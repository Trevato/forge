/** Unlinking the parent forge is refused while it is the account's only way in (#7130), in the module and in Settings. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { LAST_WAY_IN, linkParent, linkedParent, unlinkParent } from "../src/core/federation.ts";
import { changePassword, createUser } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

const ISSUER = "https://parent.test";

describe("unlinking the parent forge as the last way in", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  /** An account as a first parent sign-in makes it: no password, no passkey, one link. */
  const parentOnly = async (username: string) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test` });
    if (!made.ok) throw new Error(made.error);
    const id = made.value.id;
    expect(linkParent(app.db, id, ISSUER, `${username}-sub`)).toEqual({ ok: true, value: "linked" });
    return { id, cookie: `forge_session=${createSession(app.db, id).token}` };
  };
  const addPasskey = (userId: string) =>
    app.db
      .query("INSERT INTO passkey (id, user_id, credential_id, name, alg, key) VALUES (?1, ?2, ?3, 'k', 'ES256', '{}')")
      .run(`pk-${userId}`, userId, `cred-${userId}`);
  const unlink = (cookie: string) =>
    fetch(`${servers.url}/settings/parent/unlink`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: servers.url },
      body: "",
    });
  /** Settings as the next request shows it, carrying the flash the redirect set. */
  const settingsAfter = async (res: Response, cookie: string) => {
    const flash = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("forge_flash="));
    return (await fetch(`${servers.url}/settings`, { headers: { cookie: flash ? `${cookie}; ${flash}` : cookie } })).text();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-last-way-in-"));
    app = createApp({ dataDir, port: 0, parentUrl: ISSUER });
    servers = await serve(app);
  }, 60_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with no password and no passkey, unlinking is refused and the link stays", async () => {
    const { id } = await parentOnly("pat");
    expect(unlinkParent(app.db, id, ISSUER)).toEqual({ ok: false, error: "last_way_in" });
    expect(linkedParent(app.db, id, ISSUER)).toBe("pat-sub");
  });

  test("after a passkey is added, unlinking succeeds", async () => {
    const { id } = await parentOnly("pam");
    expect(unlinkParent(app.db, id, ISSUER).ok).toBe(false);
    addPasskey(id);
    expect(unlinkParent(app.db, id, ISSUER)).toEqual({ ok: true, value: "unlinked" });
    expect(linkedParent(app.db, id, ISSUER)).toBeUndefined();
  });

  test("after a password is set, unlinking succeeds", async () => {
    const { id } = await parentOnly("pia");
    expect(unlinkParent(app.db, id, ISSUER).ok).toBe(false);
    expect((await changePassword(app.db, id, "a-long-federation-passphrase")).ok).toBe(true);
    expect(unlinkParent(app.db, id, ISSUER)).toEqual({ ok: true, value: "unlinked" });
    expect(linkedParent(app.db, id, ISSUER)).toBeUndefined();
  });

  test("Settings says the refusal in words and keeps the link", async () => {
    const { id, cookie } = await parentOnly("pip");
    const res = await unlink(cookie);
    expect(res.status).toBe(303);
    expect(linkedParent(app.db, id, ISSUER)).toBe("pip-sub");
    const page = await settingsAfter(res, cookie);
    expect(page).toContain(LAST_WAY_IN);
    expect(page).not.toContain("not linked");
  });

  test("Settings unlinks once a passkey exists", async () => {
    const { id, cookie } = await parentOnly("pru");
    addPasskey(id);
    const res = await unlink(cookie);
    expect(res.status).toBe(303);
    expect(linkedParent(app.db, id, ISSUER)).toBeUndefined();
    const page = await settingsAfter(res, cookie);
    expect(page).toContain("Unlinked.");
    expect(page).not.toContain(LAST_WAY_IN);
  });
});
