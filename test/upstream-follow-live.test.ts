/** Turning following on or off reaches readers without the address (#3617). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setFollowUpstream } from "../src/actions/upstream_follow.ts";
import { audienceFilter, eventAudience } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";

let dataDir = "";
let app: App;
let alice: User;
let guest: User;
let repo: Repo;
const URL_SECRET = "https://example.com/private-owner/secret-repo.git";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-follow-live-"));
  app = createApp({ dataDir, port: 0 });
  const user = (username: string, extra: object = {}) =>
    createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...extra,
    });
  alice = ok(await user("alice", { adminIfFirst: true }));
  guest = ok(await user("guest"));
  repo = ok(await createRepo(app, alice, { name: "square", visibility: "public" }));
});

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a flip emits an admins' event and a readers' event without the URL", () => {
  ok(setFollowUpstream(app, alice, repo, { url: URL_SECRET, branch: "main", enabled: true }));
  const events = listEvents(app.db, {}).filter((e) => e.repoId === repo.id);
  const admin = events.find((e) => e.kind === "repo.upstream_follow")!;
  const reader = events.find((e) => e.kind === "repo.following")!;
  expect(eventAudience("repo.upstream_follow")).toBe("admins");
  expect(eventAudience("repo.following")).toBe("readers");
  expect(reader.payload).toEqual({ enabled: true });
  expect(JSON.stringify(reader)).not.toContain("secret-repo");
  expect(JSON.stringify(reader)).not.toContain("example.com");

  const forGuest = audienceFilter(app.db, guest);
  expect(forGuest(reader)).toBe(true);
  expect(forGuest(admin)).toBe(false);
  expect(audienceFilter(app.db, alice)(admin)).toBe(true);
});

test("turning it off sends enabled false", () => {
  ok(setFollowUpstream(app, alice, repo, { url: "", branch: "", enabled: false }));
  const last = listEvents(app.db, {}).filter((e) => e.kind === "repo.following").sort((a, b) => (a.id < b.id ? 1 : -1))[0]!;
  expect(last.payload).toEqual({ enabled: false });
});

test("the live client listens for both kinds", async () => {
  const src = await Bun.file(join(import.meta.dir, "../src/web/live.ts")).text();
  expect(src).toContain("'repo.upstream_follow'");
  expect(src).toContain("'repo.following'");
});
