/** `readReturns` refuses a bad window, no viewer and a repository the viewer may not read alike (#6761). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { RETURNS_DAYS, readReturns } from "../src/actions/returns.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let viewer: User;
const DAY = 86_400_000;
const now = new Date("2026-10-01T12:00:00.000Z");

async function person(username: string): Promise<User> {
  const made = await createUser(app.db, {
    origin: "seed",
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: false,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-returns-refusals-"));
  app = createApp({ dataDir, port: 0 });
  viewer = await person("olive");
  const stranger = await person("sam");
  proveAll(app);
  promote(app.db, viewer, stranger);
  for (const [who, name] of [
    [viewer, "mine"],
    [stranger, "theirs"],
  ] as const) {
    const made = await createRepo(app, who, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }
});

afterAll(async () => {
  app.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

test("no viewer is unauthorized", () => {
  const r = readReturns(app, undefined, { now });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe("unauthorized");
});

test("days outside 1..max or not whole are bad_days; the edges and omitted are accepted", () => {
  for (const days of [0, 91, 1.5, NaN, -1]) {
    const r = readReturns(app, viewer, { days, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_days");
  }
  const span = (days?: number) => {
    const r = readReturns(app, viewer, days === undefined ? { now } : { days, now });
    if (!r.ok) throw new Error(r.error);
    return Date.parse(r.value.window.until) - Date.parse(r.value.window.since);
  };
  expect(span(1)).toBe(DAY);
  expect(span(RETURNS_DAYS.max)).toBe(RETURNS_DAYS.max * DAY);
  expect(span()).toBe(RETURNS_DAYS.default * DAY);
});

test("a stranger's, a missing and a malformed repo are the same not_found", () => {
  const seen = ["sam/theirs", "olive/nothing", "nobody/x", "a/b/c", "a/"].map((repo) =>
    readReturns(app, viewer, { repo, now }),
  );
  for (const r of seen) expect(r).toEqual(seen[0]!);
  expect(seen[0]!.ok).toBe(false);
  if (!seen[0]!.ok) expect(seen[0]!.error).toBe("not_found");
});

test("without repo only the viewer's repository is listed, and the window ends at now", () => {
  const r = readReturns(app, viewer, { now });
  if (!r.ok) throw new Error(r.error);
  expect(r.value.repos).toEqual(["olive/mine"]);
  expect(r.value.window.until).toBe(now.toISOString());
  const one = readReturns(app, viewer, { repo: "olive/mine", now });
  if (!one.ok) throw new Error(one.error);
  expect(one.value.repos).toEqual(["olive/mine"]);
});
