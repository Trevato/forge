/**
 * The first screens of a forge that sends no mail: the owner's one passkey is
 * said once, with the way to add a second, and the everyday account asks for
 * no email.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addPasskey } from "../src/core/passkeys.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { everydayAsk } from "../src/web/pages/everyday.ts";
import { secondPasskeyLine } from "../src/web/pages/next-steps.ts";

let dir = "";
let app: App;
const key = (id: string) => ({ id, alg: "ES256" as const, key: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" }, signCount: 0 });
const ctxOf = (user: User): Ctx => ({ app, auth: { user } }) as unknown as Ctx;

async function person(username: string, password?: string): Promise<User> {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@no-email.invalid`, isAdmin: true, ...(password === undefined ? {} : { password }) });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-no-mail-"));
  app = createApp({ dataDir: dir, port: 0 });
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("an owner with one passkey and no password is told once to add a second; with two, or a password, nothing is said", async () => {
  const ada = await person("ada");
  expect(secondPasskeyLine(ctxOf(ada), ada)).toBeNull();
  expect(addPasskey(app.db, ada.id, "Passkey", key("k1")).ok).toBe(true);
  const line = secondPasskeyLine(ctxOf(ada), ada)?.text ?? "";
  expect(line).toContain("You sign in with one passkey.");
  expect(line).toContain('href="/settings/passkeys"');
  expect(line).not.toMatch(/email|recovery code/i);
  expect(addPasskey(app.db, ada.id, "Phone", key("k2")).ok).toBe(true);
  expect(secondPasskeyLine(ctxOf(ada), ada)).toBeNull();
  const bo = await person("bo", "a-long-enough-password");
  expect(addPasskey(app.db, bo.id, "Passkey", key("k3")).ok).toBe(true);
  expect(secondPasskeyLine(ctxOf(bo), bo)).toBeNull();
});

test("the everyday account asks for an email only on a forge that sends mail", async () => {
  const cy = await person("cy");
  expect(everydayAsk(ctxOf(cy), cy).text).not.toContain('name="email"');
  app.config.mailer = async () => true;
  try {
    expect(everydayAsk(ctxOf(cy), cy).text).toContain('name="email"');
  } finally {
    delete app.config.mailer;
  }
});
