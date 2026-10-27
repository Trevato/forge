/**
 * Minting a proposal token refuses a bad child name or origin, and makes no
 * secret: no token row and no proposal row is left behind.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { mintProposalToken, proposalOf } from "../src/core/proposal_token.ts";
import type { Repo } from "../src/core/repos.ts";
import { verifyToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("minting a proposal token", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let lib: Repo;

  const count = (table: string) =>
    app.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proposal-refusals-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const repo = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    lib = repo.value;
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a good child and origin give a secret once", () => {
    const minted = mintProposalToken(app.db, alice.id, lib.id, {
      child: "shop",
      origin: "https://shop.example.com",
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.value.token).toStartWith("forge_");
    expect(proposalOf(app.db, minted.value.id)).toMatchObject({
      child: "shop",
      origin: "https://shop.example.com/",
    });
    expect(verifyToken(app.db, minted.value.token).ok).toBe(true);
    // Only a hash is stored: the secret is not in any row.
    const rows = JSON.stringify(app.db.query("SELECT * FROM token").all());
    expect(rows).not.toContain(minted.value.token);
  });

  const refuse = (child: string, origin: string, error: "invalid_child" | "invalid_origin") => {
    const tokens = count("token");
    const proposals = count("proposal_token");
    const r = mintProposalToken(app.db, alice.id, lib.id, { child, origin });
    expect(r).toEqual({ ok: false, error });
    expect(count("token")).toBe(tokens);
    expect(count("proposal_token")).toBe(proposals);
  };

  test.each(["my shop", "a/b", "shop/", "../x", "", "Shop"])(
    "child %p is invalid_child",
    (child) => refuse(child, "https://shop.example.com", "invalid_child"),
  );

  test.each([
    "http://shop.example.com/path",
    "http://",
    "javascript:alert(1)",
    "https://",
    "",
  ])("origin %p is invalid_origin", (origin) =>
    refuse("shop", origin, "invalid_origin"),
  );
});
