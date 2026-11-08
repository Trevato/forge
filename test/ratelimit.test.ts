/**
 * The rate limiter driven directly, with a fake clock.
 *
 * The HTTP tests in agents.test.ts see 429s; these pin the arithmetic under
 * them: the window slides (no double burst across a minute boundary), a
 * refusal is not counted, Retry-After and X-RateLimit-Reset point at the
 * moment the oldest hit leaves the window, and the environment parses the
 * way the module comment promises.
 */
import { describe, expect, test } from "bun:test";
import {
  limitsFromEnv,
  RateLimiter,
  type RateLimits,
  WINDOW_MS,
} from "../src/core/ratelimit.ts";

/** A limiter on a clock the test moves by hand; `at` is milliseconds. */
function clocked(limits: Partial<RateLimits> = {}) {
  const clock = { at: 0 };
  const limiter = new RateLimiter(
    { perMinute: 3, adminPerMinute: 30, enabled: true, ...limits },
    () => clock.at,
  );
  return { clock, limiter };
}

describe("RateLimiter", () => {
  test("at the limit the next take is refused, pointing at when the oldest hit leaves", () => {
    const { clock, limiter } = clocked({ perMinute: 3 });
    for (const at of [1_000, 2_000, 3_000]) {
      clock.at = at;
      expect(limiter.take("k", "ro").allowed).toBe(true);
    }
    clock.at = 10_500;
    const refused = limiter.take("k", "ro");
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.limit).toBe(3);
    // Oldest hit at 1 000 ms leaves at 1 000 + 60 000 = 61 000 ms.
    // Wait = 61 000 − 10 500 = 50 500 ms → ceil to 51 s.
    expect(refused.retryAfter).toBe(51);
    expect(refused.reset).toBe(61);

    clock.at = 60_999;
    expect(limiter.take("k", "ro").allowed).toBe(false);
    clock.at = 61_000;
    const back = limiter.take("k", "ro");
    expect(back.allowed).toBe(true);
    // Hits at 2 000, 3 000, 61 000 are live: 3 of 3 used.
    expect(back.remaining).toBe(0);
  });

  test("allowed takes count down remaining and reset a window from now", () => {
    const { clock, limiter } = clocked({ perMinute: 3 });
    clock.at = 5_250;
    const first = limiter.take("k", "rw");
    expect(first).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      reset: Math.ceil((5_250 + WINDOW_MS) / 1000),
      retryAfter: 0,
    });
    expect(limiter.take("k", "rw").remaining).toBe(1);
    expect(limiter.take("k", "rw").remaining).toBe(0);
  });

  test("a burst at 59.9 s and another at 60.1 s: the second is refused", () => {
    const limit = 10;
    const { clock, limiter } = clocked({ perMinute: limit });
    clock.at = 59_900;
    let first = 0;
    for (let i = 0; i < limit; i++) if (limiter.take("k", "ro").allowed) first++;
    expect(first).toBe(limit);

    // A fixed per-minute bucket starts afresh at 60 000 ms and would let all
    // ten through: twenty requests in 200 ms. The sliding window still holds
    // the ten from 59.9 s until 119.9 s.
    clock.at = 60_100;
    let second = 0;
    for (let i = 0; i < limit; i++) if (limiter.take("k", "ro").allowed) second++;
    expect(second).toBe(0);

    clock.at = 119_899;
    expect(limiter.take("k", "ro").allowed).toBe(false);
    clock.at = 119_900;
    expect(limiter.take("k", "ro").allowed).toBe(true);
  });

  test("a burst spread across the boundary is mostly refused on the far side", () => {
    const limit = 10;
    const { clock, limiter } = clocked({ perMinute: limit });
    // Eight at 59.9 s leave two for the next minute, not ten.
    clock.at = 59_900;
    for (let i = 0; i < 8; i++) expect(limiter.take("k", "ro").allowed).toBe(true);
    clock.at = 60_100;
    let allowed = 0;
    for (let i = 0; i < limit; i++) if (limiter.take("k", "ro").allowed) allowed++;
    expect(allowed).toBe(2);
  });

  test("hammering while refused does not push the window forward", () => {
    const { clock, limiter } = clocked({ perMinute: 2 });
    clock.at = 0;
    limiter.take("k", "ro");
    clock.at = 1_000;
    limiter.take("k", "ro");

    clock.at = 30_000;
    const promised = limiter.take("k", "ro");
    expect(promised.allowed).toBe(false);
    expect(promised.retryAfter).toBe(30);
    expect(promised.reset).toBe(60);

    // A poll loop with no sleep in it, every 10 ms until the promised time.
    for (clock.at = 30_000; clock.at < 60_000; clock.at += 10) {
      const verdict = limiter.take("k", "ro");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reset).toBe(60);
    }

    clock.at = promised.reset * 1000;
    expect(limiter.take("k", "ro").allowed).toBe(true);
  });

  test("admin scope uses adminPerMinute; ro and rw share one budget", () => {
    const { limiter } = clocked({ perMinute: 2, adminPerMinute: 5 });

    expect(limiter.take("token", "ro").allowed).toBe(true);
    expect(limiter.take("token", "rw").allowed).toBe(true);
    const rw = limiter.take("token", "rw");
    expect(rw.allowed).toBe(false);
    expect(rw.limit).toBe(2);
    expect(limiter.take("token", "ro").allowed).toBe(false);

    for (let i = 0; i < 5; i++) {
      const verdict = limiter.take("admin", "admin");
      expect(verdict.allowed).toBe(true);
      expect(verdict.limit).toBe(5);
      expect(verdict.remaining).toBe(4 - i);
    }
    expect(limiter.take("admin", "admin").allowed).toBe(false);
  });

  test("keys are counted apart", () => {
    const { limiter } = clocked({ perMinute: 1 });
    expect(limiter.take("a", "ro").allowed).toBe(true);
    expect(limiter.take("a", "ro").allowed).toBe(false);
    expect(limiter.take("b", "ro").allowed).toBe(true);
  });

  test("disabled, every take is allowed and nothing is counted", () => {
    const { limiter } = clocked({ perMinute: 0, adminPerMinute: 0, enabled: false });
    for (let i = 0; i < 1_000; i++) expect(limiter.take("k", "rw").allowed).toBe(true);
    expect(limiter.size).toBe(0);
    expect(limiter.enabled).toBe(false);
  });

  test("setLimits keeps the counted hits", () => {
    const { clock, limiter } = clocked({ perMinute: 5 });
    clock.at = 1_000;
    for (let i = 0; i < 3; i++) limiter.take("k", "ro");

    limiter.setLimits({ perMinute: 3, adminPerMinute: 30, enabled: true });
    const tightened = limiter.take("k", "ro");
    expect(tightened.allowed).toBe(false);
    expect(tightened.limit).toBe(3);

    limiter.setLimits({ perMinute: 10, adminPerMinute: 30, enabled: true });
    const loosened = limiter.take("k", "ro");
    expect(loosened.allowed).toBe(true);
    // Three earlier hits plus this one: 10 − 4.
    expect(loosened.remaining).toBe(6);
  });
});

describe("limitsFromEnv", () => {
  test("unset gives 600 ordinary and 6 000 admin", () => {
    expect(limitsFromEnv({})).toEqual({
      perMinute: 600,
      adminPerMinute: 6_000,
      enabled: true,
    });
  });

  test("FORGE_RATE_LIMIT=0 turns it off", () => {
    expect(limitsFromEnv({ FORGE_RATE_LIMIT: "0" }).enabled).toBe(false);
    expect(
      limitsFromEnv({ FORGE_RATE_LIMIT: "0", FORGE_RATE_LIMIT_ADMIN: "50" }).enabled,
    ).toBe(false);
  });

  test("non-numeric and negative values fall back to 600", () => {
    for (const raw of ["lots", "-5", "-0.5", "NaN", "Infinity"]) {
      const limits = limitsFromEnv({ FORGE_RATE_LIMIT: raw });
      expect(limits.enabled).toBe(true);
      expect(limits.perMinute).toBe(600);
    }
  });

  test("a fractional limit is floored", () => {
    expect(limitsFromEnv({ FORGE_RATE_LIMIT: "12.9" }).perMinute).toBe(12);
  });

  test("the admin limit is never below the ordinary one", () => {
    // Raising the ordinary limit past the admin default lifts admin with it.
    expect(limitsFromEnv({ FORGE_RATE_LIMIT: "10000" }).adminPerMinute).toBe(10_000);
    // An explicit admin limit below the ordinary one is lifted to it.
    expect(
      limitsFromEnv({ FORGE_RATE_LIMIT: "10000", FORGE_RATE_LIMIT_ADMIN: "100" })
        .adminPerMinute,
    ).toBe(10_000);
    // A bad admin value falls back to the admin default.
    expect(
      limitsFromEnv({ FORGE_RATE_LIMIT: "5", FORGE_RATE_LIMIT_ADMIN: "-1" })
        .adminPerMinute,
    ).toBe(6_000);
    // An explicit admin limit above the ordinary one is kept.
    expect(
      limitsFromEnv({ FORGE_RATE_LIMIT: "5", FORGE_RATE_LIMIT_ADMIN: "50" })
        .adminPerMinute,
    ).toBe(50);
  });
});
