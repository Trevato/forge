/**
 * Refused first asks are kept (#11525): one row each, the ask cut to 200
 * characters, 20 per actor per hour, 30 days; a success leaves none.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstAsk } from "../src/actions/first_ask.ts";
import { createApp, type App } from "../src/app.ts";
import { KEEP_MS, listRefusals, recordRefusal } from "../src/core/first_ask_refusals.ts";
import { MAX_BODY } from "../src/core/issues.ts";
import { FORGE_REPO_WORDS, SAY_SOMETHING_WORDS } from "../src/actions/tell_words.ts";
import { NEW_APP_ERRORS } from "../src/actions/apps.ts";
import { deriveAppName } from "../src/web/pages/apps-name.ts";
import { listReposOwnedBy } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { TOO_LONG_WORDS } from "../src/actions/tell.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let maria: User;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-first-ask-refusal-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "maria", email: "m@x.test", password: "a-long-refusal-passphrase", isAdmin: true });
  if (!u.ok) throw new Error("user");
  maria = u.value;
});
afterEach(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const apps = () => listReposOwnedBy(app.db, maria.id).length;

test("an empty ask leaves one row and no app, words unchanged", async () => {
  const r = await firstAsk(app, maria, "   ", false);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.words).toBe(SAY_SOMETHING_WORDS);
  const rows = listRefusals(app.db, 10, Date.now());
  expect(rows.length).toBe(1);
  expect(rows[0]!.actorId).toBe(maria.id);
  expect(rows[0]!.words).toBe(SAY_SOMETHING_WORDS);
  expect(apps()).toBe(0);
});

test("too long, nobody signed in and a bad from each leave one row", async () => {
  const long = "x".repeat(MAX_BODY + 1);
  const a = await firstAsk(app, maria, long, false);
  if (a.ok) throw new Error("kept");
  expect(a.error.words).toBe(TOO_LONG_WORDS);
  await firstAsk(app, undefined, "a menu page", false);
  await firstAsk(app, maria, "a menu page", false, "not-a-from-value-\u0000");
  const rows = listRefusals(app.db, 10, Date.now());
  expect(rows.length).toBe(3);
  expect(rows.filter((r) => r.actorId === null).length).toBe(1);
  expect(rows.every((r) => r.ask.length <= 200)).toBe(true);
  expect(apps()).toBe(0);
});

test("an unverified actor leaves one row and no app", async () => {
  const u = await createUser(app.db, { origin: "seed", username: "newbie", email: "n@x.test", password: "a-long-unverified-passphrase" });
  if (!u.ok) throw new Error("user");
  const r = await firstAsk(app, u.value, "A weekly menu page", false);
  if (r.ok) throw new Error("kept");
  expect(r.error.words).toBe("Verify your email first.");
  const rows = listRefusals(app.db, 10, Date.now());
  expect(rows.length).toBe(1);
  expect(rows[0]!.actorId).toBe(u.value.id);
  expect(rows[0]!.words).toBe("Verify your email first.");
  expect(listReposOwnedBy(app.db, u.value.id).length).toBe(0);
});

test("an ask that resolves to the forge repository leaves one row and no app", async () => {
  const ask = "A weekly menu page";
  app.config.forgeRepo = `maria/${deriveAppName(ask)}`;
  const r = await firstAsk(app, maria, ask, false);
  if (r.ok) throw new Error("kept");
  expect(r.error.words).toBe(FORGE_REPO_WORDS);
  const rows = listRefusals(app.db, 10, Date.now());
  expect(rows.length).toBe(1);
  expect(rows[0]!.words).toBe(FORGE_REPO_WORDS);
  expect(apps()).toBe(0);
});

test("an app that cannot be made leaves one row and no app", async () => {
  const r = await firstAsk(app, maria, "!!!", false);
  if (r.ok) throw new Error("kept");
  expect(r.error.words).toBe(NEW_APP_ERRORS.no_name!);
  const rows = listRefusals(app.db, 10, Date.now());
  expect(rows.length).toBe(1);
  expect(rows[0]!.words).toBe(NEW_APP_ERRORS.no_name!);
  expect(apps()).toBe(0);
});

test("a success leaves no row", async () => {
  const r = await firstAsk(app, maria, "A weekly menu page for the bakery", false);
  expect(r.ok).toBe(true);
  expect(listRefusals(app.db, 10, Date.now()).length).toBe(0);
});

test("a 5,000-character ask is stored as 200", () => {
  recordRefusal(app.db, { actorId: maria.id, ask: "y".repeat(5000), words: "w" }, Date.now());
  expect(listRefusals(app.db, 1, Date.now())[0]!.ask.length).toBe(200);
});

test("the 21st refusal in an hour is dropped; another actor and a later hour are not", () => {
  const now = 1_800_000_000_000;
  for (let i = 0; i < 25; i++) recordRefusal(app.db, { actorId: maria.id, ask: `a${i}`, words: "w" }, now + i);
  expect(listRefusals(app.db, 100, now + 100).length).toBe(20);
  recordRefusal(app.db, { actorId: "other", ask: "b", words: "w" }, now + 30);
  expect(listRefusals(app.db, 100, now + 100).length).toBe(21);
  recordRefusal(app.db, { actorId: maria.id, ask: "later", words: "w" }, now + 3_700_000);
  expect(listRefusals(app.db, 1, now + 3_700_000)[0]!.ask).toBe("later");
});

test("rows older than 30 days are pruned on write, and the list is newest first", () => {
  const now = 1_800_000_000_000;
  recordRefusal(app.db, { actorId: "a", ask: "old", words: "w" }, now);
  recordRefusal(app.db, { actorId: "a", ask: "mid", words: "w" }, now + KEEP_MS - 1000);
  recordRefusal(app.db, { actorId: "a", ask: "new", words: "w" }, now + KEEP_MS + 1000);
  expect(listRefusals(app.db, 10, now + KEEP_MS + 1000).map((r) => r.ask)).toEqual(["new", "mid"]);
});
