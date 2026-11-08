/**
 * `core/invites.ts` pinned directly, with `now` passed in: the day count is a
 * whole number from 1 to 30, an invite is open until its expiry instant, it
 * redeems once for one account, and taking the account back reopens it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import invite from "../src/core/migrations/20261016200000-invite.ts";
import {
  DEFAULT_DAYS,
  MAX_DAYS,
  inviteOpen,
  inviteSpentBy,
  listInvites,
  mintInvite,
  parseDays,
  redeemInvite,
  reopenInvite,
} from "../src/core/invites.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

describe("parseDays", () => {
  test("the default for absent, the bounds for present", () => {
    expect(parseDays(undefined)).toEqual({ ok: true, value: DEFAULT_DAYS });
    expect(parseDays(null)).toEqual({ ok: true, value: DEFAULT_DAYS });
    expect(parseDays(1)).toEqual({ ok: true, value: 1 });
    expect(parseDays(MAX_DAYS)).toEqual({ ok: true, value: MAX_DAYS });
    for (const bad of [0, MAX_DAYS + 1, 1.5, "7", Number.NaN, -1, Infinity]) {
      expect(parseDays(bad)).toEqual({ ok: false, error: "invalid_days" });
    }
  });
});

describe("an invite's life", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(invite);
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, username TEXT NOT NULL)");
  });

  test("open before its expiry, not at or after it", () => {
    const { token } = mintInvite(db, "owner", 2, T0);
    expect(inviteOpen(db, token, T0)).toBe(true);
    expect(inviteOpen(db, token, T0 + 2 * DAY - 1)).toBe(true);
    expect(inviteOpen(db, token, T0 + 2 * DAY)).toBe(false);
    expect(inviteOpen(db, token, T0 + 3 * DAY)).toBe(false);
    expect(inviteOpen(db, "invite_unknown", T0)).toBe(false);
  });

  test("redeems once; a second redeem by anyone fails", () => {
    const { token } = mintInvite(db, "owner", 2, T0);
    expect(redeemInvite(db, token, "ada", T0 + 1)).toBe(true);
    expect(inviteOpen(db, token, T0 + 2)).toBe(false);
    expect(redeemInvite(db, token, "ada", T0 + 2)).toBe(false);
    expect(redeemInvite(db, token, "bob", T0 + 2)).toBe(false);
    expect(inviteSpentBy(db, "bob")).toBeUndefined();
  });

  test("an expired invite never redeems", () => {
    const { token } = mintInvite(db, "owner", 1, T0);
    expect(redeemInvite(db, token, "ada", T0 + DAY)).toBe(false);
    expect(redeemInvite(db, token, "ada", T0 + 5 * DAY)).toBe(false);
    expect(inviteSpentBy(db, "ada")).toBeUndefined();
    expect(listInvites(db, T0 + DAY)[0]!.state).toBe("expired");
  });

  test("an unknown token redeems nothing", () => {
    mintInvite(db, "owner", 2, T0);
    expect(redeemInvite(db, "invite_nope", "ada", T0)).toBe(false);
  });

  test("inviteSpentBy names the redeemer's invite", () => {
    const a = mintInvite(db, "owner", 2, T0);
    const b = mintInvite(db, "owner", 2, T0);
    redeemInvite(db, a.token, "ada", T0);
    expect(inviteSpentBy(db, "ada")).toBe(a.invite.id);
    expect(inviteSpentBy(db, "bob")).toBeUndefined();
    expect(inviteSpentBy(db, "owner")).toBeUndefined();
    expect(b.invite.id).not.toBe(a.invite.id);
  });

  test("reopenInvite gives back only that account's invite, once more redeemable", () => {
    const a = mintInvite(db, "owner", 2, T0);
    const b = mintInvite(db, "owner", 2, T0);
    redeemInvite(db, a.token, "ada", T0);
    redeemInvite(db, b.token, "bob", T0);
    reopenInvite(db, "ada");
    expect(inviteSpentBy(db, "ada")).toBeUndefined();
    expect(inviteOpen(db, a.token, T0 + 1)).toBe(true);
    expect(inviteOpen(db, b.token, T0 + 1)).toBe(false);
    expect(inviteSpentBy(db, "bob")).toBe(b.invite.id);
    expect(redeemInvite(db, a.token, "cy", T0 + 1)).toBe(true);
    reopenInvite(db, "nobody");
    expect(inviteSpentBy(db, "cy")).toBe(a.invite.id);
  });

  test("a redeemed invite lists who joined with it and when; null when unused or the account is gone", () => {
    db.query("INSERT INTO user (id, username) VALUES ('u1', 'ada')").run();
    const used = mintInvite(db, "owner", 2, T0);
    const gone = mintInvite(db, "owner", 2, T0);
    const fresh = mintInvite(db, "owner", 2, T0);
    redeemInvite(db, used.token, "u1", T0 + 1000);
    redeemInvite(db, gone.token, "u-deleted", T0 + 2000);
    const byId = new Map(listInvites(db, T0 + 3000).map((i) => [i.id, i]));
    expect(byId.get(used.invite.id)).toMatchObject({ state: "used", usedBy: "ada", usedAt: new Date(T0 + 1000).toISOString() });
    expect(byId.get(gone.invite.id)).toMatchObject({ state: "used", usedBy: null, usedAt: new Date(T0 + 2000).toISOString() });
    expect(byId.get(fresh.invite.id)).toMatchObject({ state: "open", usedBy: null, usedAt: null });
    expect(fresh.invite).toMatchObject({ usedBy: null, usedAt: null });
  });
});
