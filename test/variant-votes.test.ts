/**
 * `voteVariant` on its own: a writer's dislike closes the pull with one
 * comment and one ledger row; a like leaves it open; a refused vote writes
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REASON, REASON_MAX, voteVariant } from "../src/actions/variants.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listDecisions } from "../src/core/decisions.ts";
import { listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("voteVariant", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let lib: Repo;
  let n = 0;

  const variant = async (variantGroup: string | null = "g") => {
    const branch = `b${++n}`;
    const c = await commitToBranch(app, alice, lib, {
      branch,
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, lib, {
      title: `Try ${branch}`,
      baseBranch: "main",
      headBranch: branch,
      ...(variantGroup === null ? {} : { variantGroup }),
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const fresh = (num: number) => getPull(app.db, lib.id, num)!;
  const ledger = (id: string) =>
    listDecisions(app.db, lib.id, { kind: "lean" }).filter((r) => r.issueId === id);
  const comments = (id: string) => listComments(app.db, id).length;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-vvotes-"));
    app = createApp({ dataDir, port: 0 });
    const make = async (username: string, first: boolean) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await make("alice", true);
    bob = await make("bob", false);
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seed = await commitToBranch(app, alice, lib, {
      message: "seed",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    if (!seed.ok) throw new Error(JSON.stringify(seed.error));
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer's dislike closes the pull with one comment and one vote", async () => {
    const pull = await variant();
    const before = comments(pull.id);
    const r = voteVariant(app, alice, lib, pull, "dislike", "too   noisy\n");
    expect(r).toEqual({ ok: true, value: { closed: true } });
    expect(fresh(pull.number).state).toBe("closed");
    const added = listComments(app.db, pull.id).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.body.startsWith("Closed: not chosen among its variants.")).toBe(true);
    expect(added[0]!.body).toContain("too noisy");
    const rows = ledger(pull.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("dislike");
    expect((rows[0]!.state as any).reason).toBe("too noisy");
  });

  test("an empty reason is the default; a long one is cut to REASON_MAX", async () => {
    const a = await variant();
    voteVariant(app, alice, lib, a, "dislike", "  ");
    expect((ledger(a.id)[0]!.state as any).reason).toBe(DEFAULT_REASON);
    expect(DEFAULT_REASON).toBe("Not this one.");

    const b = await variant();
    voteVariant(app, alice, lib, b, "dislike", "x".repeat(500));
    expect((ledger(b.id)[0]!.state as any).reason).toBe("x".repeat(REASON_MAX));
  });

  test("a like records a vote and leaves the pull open", async () => {
    const pull = await variant();
    const before = comments(pull.id);
    expect(voteVariant(app, alice, lib, pull, "like")).toEqual({
      ok: true,
      value: { closed: false },
    });
    expect(fresh(pull.number).state).toBe("open");
    expect(comments(pull.id)).toBe(before);
    const rows = ledger(pull.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("like");
  });

  test("a refused vote leaves no comment and no ledger row", async () => {
    const pull = await variant();
    const plain = await variant(null);
    const before = comments(pull.id);
    const plainBefore = comments(plain.id);

    const guest = voteVariant(app, undefined, lib, pull, "dislike", "no");
    expect(guest).toEqual({ ok: false, error: "unauthorized" });
    const reader = voteVariant(app, bob, lib, pull, "dislike", "no");
    expect(reader).toEqual({ ok: false, error: "forbidden" });
    const solo = voteVariant(app, alice, lib, plain, "dislike", "no");
    expect(solo).toEqual({ ok: false, error: "not_variant" });

    expect(comments(pull.id)).toBe(before);
    expect(comments(plain.id)).toBe(plainBefore);
    expect(ledger(pull.id)).toHaveLength(0);
    expect(ledger(plain.id)).toHaveLength(0);
    expect(fresh(pull.number).state).toBe("open");
    expect(fresh(plain.number).state).toBe("open");
  });

  test("a second dislike on the closed pull is not_open and adds nothing", async () => {
    const pull = await variant();
    expect(voteVariant(app, alice, lib, pull, "dislike", "first").ok).toBe(true);
    const closed = fresh(pull.number);
    const before = comments(pull.id);
    expect(voteVariant(app, alice, lib, closed, "dislike", "again")).toEqual({
      ok: false,
      error: "not_open",
    });
    expect(comments(pull.id)).toBe(before);
    expect(ledger(pull.id)).toHaveLength(1);
  });
});
