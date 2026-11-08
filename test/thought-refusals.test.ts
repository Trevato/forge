import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { keepThought } from "../src/actions/thought.ts";
import { createUser, type User } from "../src/core/users.ts";

describe("keepThought refusals", () => {
  let dataDir: string;
  let app: App;
  let user: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-thought-refusals-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "mira",
      email: "mira@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error("user");
    user = made.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const count = () =>
    app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM thought").get()?.n ?? -1;

  test("a text thought is kept and answered with an id and receivedAt", () => {
    const before = count();
    const r = keepThought(app, user, "hello", "api");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(r.value.receivedAt))).toBe(false);
    expect(count()).toBe(before + 1);
  });

  test.each([
    ["a number", 42],
    ["an object", { text: "x" }],
    ["null", null],
  ])("%s is not_text and nothing is stored", (_name, body) => {
    const before = count();
    const r = keepThought(app, user, body, "api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not_text");
    expect(count()).toBe(before);
  });

  test("signed out is unauthorized and nothing is stored", () => {
    const before = count();
    const r = keepThought(app, undefined, "hello", "api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unauthorized");
    expect(count()).toBe(before);
  });
});
