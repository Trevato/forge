/**
 * `actions/invites.ts` pinned directly (#7513): only an admin mints, lists or
 * revokes, and the token appears once, in the mint's return, and nowhere
 * else — not in a listing, not in an event the bus appended, not in a log
 * line written while it happened. A revoked link opens no door.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { inviteLink, list, mint, revoke } from "../src/actions/invites.ts";
import { signUp } from "../src/actions/users.ts";
import { MAX_DAYS } from "../src/core/invites.ts";
import { listEvents } from "../src/core/events.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { logLevel, setLogLevel, type LogLevel } from "../src/kernel/log.ts";
import { setSignup } from "../src/settings/signup.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";

const PASSWORD = "an-invited-passphrase";

describe("invite links through the action", () => {
  let dir = "";
  let app: App;
  let admin: User;
  let member: User;
  let guest: User;
  let found: LogLevel;
  const lines: string[] = [];
  const spies: { mockRestore(): void }[] = [];

  /** Every console line written while `fn` runs, at the debug floor. */
  const logged = <T>(fn: () => T): T => {
    lines.length = 0;
    setLogLevel("debug");
    const record = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      spies.push(spyOn(console, level).mockImplementation(record));
    try {
      return fn();
    } finally {
      for (const s of spies.splice(0)) s.mockRestore();
      setLogLevel("error");
    }
  };

  const person = async (username: string) => {
    const made = await createUser(app.db, { username, email: `${username}@f.dev`, password: PASSWORD, origin: "seed" });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  beforeAll(async () => {
    found = logLevel();
    setLogLevel("error");
    dir = await mkdtemp(join(tmpdir(), "forge-invites-action-"));
    app = createApp({ dataDir: dir, port: 0 });
    const made = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: PASSWORD });
    if (!made.ok) throw new Error(made.error);
    admin = made.value;
    member = await person("mel");
    promote(app.db, member);
    guest = await person("gus");
    setSignup(app.db, "invite", admin.id);
  });
  afterAll(async () => {
    setLogLevel(found);
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("an admin's mint returns the link once; no listing, event or log line carries it", () => {
    const since = listEvents(app.db, { limit: 1 })[0]?.id;
    const made = logged(() => mint(app, admin, 3));
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const { invite, token } = made.value;
    expect(token).toStartWith("invite_");
    expect(invite.state).toBe("open");
    expect(inviteLink("https://f.dev/", token)).toBe(`https://f.dev/signup?invite=${token}`);
    // 3 days from creation, to the millisecond.
    expect(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)).toBe(3 * 86_400_000);
    const mintLines = [...lines];

    const listed = logged(() => list(app, admin));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((i) => i.id)).toContain(invite.id);
    const listLines = [...lines];

    const revoked = logged(() => revoke(app, admin, invite.id));
    expect(revoked.ok).toBe(true);
    if (revoked.ok) expect(revoked.value.state).toBe("revoked");
    const revokeLines = [...lines];

    const secrets = [token, sha256(token), token.slice("invite_".length)];
    const events = listEvents(app.db, { limit: 50, ...(since === undefined ? {} : { afterId: since }) });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("invite.minted");
    expect(kinds).toContain("invite.revoked");
    for (const e of events) {
      const text = JSON.stringify(e);
      for (const s of secrets) expect(text).not.toContain(s);
    }
    const minted = events.find((e) => e.kind === "invite.minted")!;
    expect(minted.payload).toEqual({ id: invite.id, expiresAt: invite.expiresAt });
    expect(events.find((e) => e.kind === "invite.revoked")!.payload).toEqual({ id: invite.id });

    const listing = JSON.stringify(list(app, admin));
    for (const s of secrets) expect(listing).not.toContain(s);
    for (const line of [...mintLines, ...listLines, ...revokeLines])
      for (const s of secrets) expect(line).not.toContain(s);
  });

  test("a revoked link signs nobody up; an open one does", async () => {
    const made = mint(app, admin, undefined);
    if (!made.ok) throw new Error(made.error);
    expect(revoke(app, admin, made.value.invite.id).ok).toBe(true);
    const refused = await signUp(
      app,
      { username: "rex", email: "rex@f.dev", password: PASSWORD },
      { slot: fixtureSlot(app), invite: made.value.token },
    );
    expect(refused).toEqual({ ok: false, error: "signup_closed" });
    expect(getUserByName(app.db, "rex")).toBeUndefined();
    // A second revoke of the same link is not found: it is already shut.
    expect(revoke(app, admin, made.value.invite.id)).toEqual({ ok: false, error: "not_found" });

    const open = mint(app, admin, 1);
    if (!open.ok) throw new Error(open.error);
    const let_in = await signUp(
      app,
      { username: "ivy", email: "ivy@f.dev", password: PASSWORD },
      { slot: fixtureSlot(app), invite: open.value.token },
    );
    expect(let_in.ok).toBe(true);
  });

  test("a member, a guest and nobody get not_found for all three, and nothing changes", () => {
    const made = mint(app, admin, 7);
    if (!made.ok) throw new Error(made.error);
    const before = list(app, admin);
    const eventsBefore = listEvents(app.db, { limit: 500 }).length;
    for (const actor of [member, guest, undefined]) {
      expect(mint(app, actor, 7)).toEqual({ ok: false, error: "not_found" });
      expect(list(app, actor)).toEqual({ ok: false, error: "not_found" });
      expect(revoke(app, actor, made.value.invite.id)).toEqual({ ok: false, error: "not_found" });
    }
    // An agent account flagged admin is still not a person who may mint.
    const agent = { ...admin, kind: "agent" as const };
    expect(mint(app, agent, 7)).toEqual({ ok: false, error: "not_found" });
    expect(list(app, agent)).toEqual({ ok: false, error: "not_found" });
    expect(revoke(app, agent, made.value.invite.id)).toEqual({ ok: false, error: "not_found" });

    expect(list(app, admin)).toEqual(before);
    expect(listEvents(app.db, { limit: 500 }).length).toBe(eventsBefore);
  });

  test("days outside 1 to 30, or not a whole number, is refused and mints nothing", () => {
    const before = list(app, admin);
    for (const days of [0, -1, MAX_DAYS + 1, 1.5, "7", Number.NaN, Infinity, {}]) {
      expect(mint(app, admin, days)).toEqual({ ok: false, error: "invalid_days" });
    }
    expect(list(app, admin)).toEqual(before);
    expect(mint(app, admin, 1).ok).toBe(true);
    expect(mint(app, admin, MAX_DAYS).ok).toBe(true);
  });
});
