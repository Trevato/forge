/**
 * `newAppFromSentence` (`actions/apps.ts`) called directly: the sentence
 * names the app, a repeat gets `-2`, nothing to name from is `no_name`, and
 * the verified-account and app-limit refusals pass through unchanged.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_APP_ERRORS, newAppFromSentence } from "../src/actions/apps.ts";
import { setRole } from "../src/actions/roles.ts";
import { createApp } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { setQuota } from "../src/settings/quotas.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "forge-newapp-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, trusted: boolean, isAdmin = false) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted, username, email: `${username}@x.test`, isAdmin,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const admin = await mk("boss", true, true);
  const user = await mk("maker", true);
  const fresh = await mk("fresh", false);
  for (const who of [user, fresh]) setRole(app, admin, who.username, "member");
  return { app, admin, user, fresh };
}

test("a sentence makes an app named from it; again makes name-2", async () => {
  const { app, user } = await world();
  const sentence = "A tracker for tide tables";
  const first = await newAppFromSentence(app, user, { sentence });
  expect(first).toMatchObject({ ok: true });
  if (!first.ok) return;
  expect(first.repo.name).toBe(first.name);
  const second = await newAppFromSentence(app, user, { sentence });
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.name).toBe(`${first.name}-2`);
});

test("a sentence with nothing to name from is no_name", async () => {
  const { app, user } = await world();
  for (const sentence of ["", "  ...  "]) {
    const made = await newAppFromSentence(app, user, { sentence });
    expect(made).toEqual({ ok: false, code: "no_name" });
  }
  expect(NEW_APP_ERRORS.no_name).toBeString();
});

test("an unverified account is refused", async () => {
  const { app, fresh } = await world();
  const made = await newAppFromSentence(app, fresh, { sentence: "tide tables" });
  expect(made).toEqual({ ok: false, code: "unverified" });
});

test("at the app limit a non-admin is refused", async () => {
  const { app, admin, user } = await world();
  setQuota(app.db, "apps", 1, admin.id);
  expect((await newAppFromSentence(app, user, { sentence: "tide tables" })).ok).toBe(true);
  expect(await newAppFromSentence(app, user, { sentence: "moon phases" })).toEqual({
    ok: false,
    code: "app_limit",
  });
});
