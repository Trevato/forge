/**
 * The work-branch rule, by hand: whose a commit is, and which branch wins.
 */

import { describe, expect, test } from "bun:test";
import {
  cachedRemoteTips,
  isMine,
  pickWorkBranch,
  TIPS_TTL_MS,
  type BranchTip,
} from "../src/origins/work-branch.ts";
import type { Provider } from "../src/origins/types.ts";

const who = { logins: ["Trevato"], emails: ["t@example.com"] };

const tip = (name: string, date: string, mine: boolean): BranchTip => ({
  name,
  oid: name,
  date,
  subject: "",
  author: "",
  mine,
});

describe("work branch", () => {
  test("a commit is the person's by login, email, GitHub noreply address or name — any case", () => {
    expect(isMine({ name: "x", email: "", login: "trevato" }, who)).toBe(true);
    expect(isMine({ name: "x", email: "T@Example.com" }, who)).toBe(true);
    expect(isMine({ name: "x", email: "123+trevato@users.noreply.github.com" }, who)).toBe(true);
    expect(isMine({ name: "x", email: "trevato@users.noreply.github.com" }, who)).toBe(true);
    expect(isMine({ name: "TREVATO", email: "other@example.com" }, who)).toBe(true);
    expect(isMine({ name: "someone", email: "123+someone@users.noreply.github.com", login: "someone" }, who)).toBe(false);
    // A noreply address for a login that merely contains theirs is not theirs.
    expect(isMine({ name: "x", email: "1+xtrevato@users.noreply.github.com" }, who)).toBe(false);
    expect(isMine({ name: "", email: "" }, { logins: [""], emails: [""] })).toBe(false);
  });

  test("the person's newest tip wins over a newer one that is not theirs, then the fallback, then the newest", () => {
    const tips = [
      tip("main", "2026-10-20T09:00:00Z", false),
      tip("workbench", "2026-10-19T12:00:00Z", true),
      tip("old-mine", "2026-01-01T00:00:00Z", true),
    ];
    expect(pickWorkBranch(tips, "main")).toBe("workbench");
    // Dates compare as times, not strings: +02:00 is two hours earlier.
    expect(
      pickWorkBranch(
        [tip("a", "2026-10-20T10:00:00+02:00", true), tip("b", "2026-10-20T09:00:00Z", true)],
        undefined,
      ),
    ).toBe("b");
    const none = tips.map((t) => ({ ...t, mine: false }));
    expect(pickWorkBranch(none, "old-mine")).toBe("old-mine");
    expect(pickWorkBranch(none, "gone")).toBe("main");
    expect(pickWorkBranch([], "main")).toBeUndefined();
  });
});

describe("work branch tips, remembered", () => {
  test("a minute per origin and repository; a refusal is not remembered", async () => {
    let asked = 0;
    let refuse = false;
    const provider = {
      listBranches: async () => {
        asked++;
        return refuse
          ? { ok: false as const, error: { error: "unreachable" as const, message: "down" } }
          : { ok: true as const, value: [{ name: "main", oid: "a".repeat(40) }] };
      },
      listCommits: async () => ({
        ok: true as const,
        value: {
          items: [{ oid: "a".repeat(40), message: "one\n\ntwo", author: { name: "x", email: "", login: "trevato", date: "2026-10-20T00:00:00Z" }, parents: [] }],
          next: null,
        },
      }),
    } as unknown as Provider;
    const t0 = 1_000_000;
    const first = await cachedRemoteTips("o1", provider, "a/b", who, t0);
    expect(first?.[0]).toMatchObject({ name: "main", subject: "one", author: "trevato", mine: true });
    await cachedRemoteTips("o1", provider, "a/b", who, t0 + TIPS_TTL_MS - 1);
    expect(asked).toBe(1);
    // Another account's origin is its own entry.
    await cachedRemoteTips("o2", provider, "a/b", who, t0);
    expect(asked).toBe(2);
    await cachedRemoteTips("o1", provider, "a/b", who, t0 + TIPS_TTL_MS);
    expect(asked).toBe(3);
    refuse = true;
    expect(await cachedRemoteTips("o3", provider, "a/b", who, t0)).toBeUndefined();
    expect(await cachedRemoteTips("o3", provider, "a/b", who, t0 + 1)).toBeUndefined();
    expect(asked).toBe(5);
  });
});
