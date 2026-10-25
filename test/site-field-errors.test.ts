/**
 * The site pages' errors are §5's field error, not `.error-note` (#5071): the
 * passkey-only sign-up's refusal sits in a `.field` as `.error`, and the notes
 * the passkey script fills name `error` as the class a failure takes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let app: App;
let servers: Servers;
let dir: string;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-site-errors-"));
  app = createApp({ dataDir: dir, port: 0, passkeyOnlySignup: true });
  servers = await serve(app);
  base = servers.url;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the sign-in note's failure class is the field error", async () => {
  const page = await (await fetch(`${base}/signin`)).text();
  expect(page).not.toContain("error-note");
  expect(page).toMatch(/<div class="field"><span [^>]*id="passkey-signin-note" data-fail="error"/);
});

test("the sign-up note waits in a field; a refused password form shows its error at the form's head", async () => {
  const page = await (await fetch(`${base}/signup`)).text();
  expect(page).not.toContain("error-note");
  expect(page).toMatch(/<div class="field"><span [^>]*id="passkey-signup-note" data-fail="error" role="status">/);

  const res = await fetch(`${base}/signup`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ username: "pw", email: "", password: "a-long-passphrase" }),
  });
  const refused = await res.text();
  expect(res.status).toBe(422);
  expect(refused).not.toContain("error-note");
  expect(refused).toMatch(/<p class="error mb" role="alert">New accounts sign up with a passkey/);
});
